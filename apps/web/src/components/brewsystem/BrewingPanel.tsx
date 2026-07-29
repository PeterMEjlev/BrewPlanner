import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BrewPot,
  BrewPotAutoEfficiency,
  BrewPump,
  BrewSystemAppSettings,
  BrewTimerState,
} from '@checklist/shared';
import { api } from '../../api';
import { clockTime } from '../../util';
import styles from './BrewingPanel.module.css';
import BrewTimer from './BrewTimer';
import PotCard, { type PotCardState, type PotUpdate } from './PotCard';
import PumpCard, { type PumpUpdate } from './PumpCard';
import { DEFAULT_BREW_THEME, buildThemeVars, mergeBrewTheme, type BrewTheme } from './theme';

/**
 * Remote mirror of the rig's main brewing screen (brew-system-v3 BrewingPanel),
 * same layout: three pot cards (BK / MLT / HLT), then Pump 1 / brew timer /
 * Pump 2, then the total-power readout.
 *
 * All state lives on the rig: this panel polls the BrewPlanner server's
 * /api/brew-system proxy and forwards user input as commands (optimistic local
 * state, fire-and-forget — same pattern as the rig's own kiosk UI). The rig's
 * backend runs the regulation loop, the shared power limit, and the safety
 * watchdog, so nothing here is safety-critical.
 *
 * Unlike the kiosk (which polls its own loopback at 1 s), this page usually
 * talks through the Cloudflare tunnel, so it polls at a fixed 2 s and debounces
 * slider commands a little harder.
 */

const POLL_MS = 2000;
// Skip polling shortly after a user command so a stale in-flight response
// can't overwrite the optimistic local state.
const POLL_SUPPRESS_MS = 2500;
const CONNECTION_LOST_AFTER = 3; // consecutive failed polls

// Fallbacks until the rig's /api/settings loads — keep in sync with
// brew-system-v3's config defaults (backend/main.py AppSettings).
const DEFAULT_MAX_WATTS = 11000;
const DEFAULT_BK_ELEMENT_WATTS = 8500;
const DEFAULT_HLT_ELEMENT_WATTS = 5000;
const FALLBACK_AUTO_EFFICIENCY: Record<'bk' | 'hlt', BrewPotAutoEfficiency> = {
  bk: {
    enabled: true,
    steps: [
      { threshold: 5, power: 100 },
      { threshold: 2, power: 60 },
      { threshold: 0.5, power: 30 },
      { threshold: 0, power: 0 },
    ],
  },
  hlt: {
    enabled: true,
    steps: [
      { threshold: 5, power: 100 },
      { threshold: 2, power: 75 },
      { threshold: 0.5, power: 45 },
      { threshold: 0, power: 0 },
    ],
  },
};

interface PanelStates {
  pots: Record<'BK' | 'MLT' | 'HLT', PotCardState>;
  pumps: Record<BrewPump, { on: boolean; speed: number }>;
}

const INITIAL_STATES: PanelStates = {
  pots: {
    BK: { pv: null, sv: 100, efficiency: 0, heaterOn: false, regulationEnabled: false },
    MLT: { pv: null, sv: 0, efficiency: 0, heaterOn: false, regulationEnabled: false },
    HLT: { pv: null, sv: 55, efficiency: 0, heaterOn: false, regulationEnabled: false },
  },
  pumps: {
    P1: { on: false, speed: 0 },
    P2: { on: false, speed: 0 },
  },
};

/** Fire-and-forget: control errors surface via the next poll, never as a crash. */
function quiet(p: Promise<unknown>): void {
  void p.catch(() => {});
}

export function BrewingPanel(): JSX.Element {
  const [states, setStates] = useState<PanelStates>(INITIAL_STATES);
  const [timerState, setTimerState] = useState<BrewTimerState>({ running: false, seconds: 0, target: 0 });
  const [priorityPot, setPriorityPot] = useState<BrewPot>('BK');
  // null = we don't know yet (first poll pending); false = server has no BREW_SYSTEM_URL.
  const [configured, setConfigured] = useState<boolean | null>(null);
  // Whether the rig has answered at least once this visit — before that, an
  // unreachable rig shows a placeholder instead of a fake zeroed panel.
  const [hadContact, setHadContact] = useState(false);
  // Wall-clock time of the last successful sync, snapshotted into state when
  // the connection is declared lost — stale readings must be unmissable.
  const [frozenSince, setFrozenSince] = useState<number | null>(null);
  const pollFailures = useRef(0);
  const lastSyncRef = useRef<number | null>(null);

  const [rigApp, setRigApp] = useState<BrewSystemAppSettings | null>(null);
  const [rigTheme, setRigTheme] = useState<BrewTheme>(DEFAULT_BREW_THEME);
  const configLoadedRef = useRef(false);

  const autoEfficiency = rigApp?.auto_efficiency;
  const maxWatts = rigApp?.max_watts ?? DEFAULT_MAX_WATTS;
  const BK_MAX_WATTS = rigApp?.bk_element_watts ?? DEFAULT_BK_ELEMENT_WATTS;
  const HLT_MAX_WATTS = rigApp?.hlt_element_watts ?? DEFAULT_HLT_ELEMENT_WATTS;

  // Per-pot regulation configs — each pot's card only re-renders when its own config changes.
  const bkRegConfig = useMemo<BrewPotAutoEfficiency>(
    () => ({
      enabled: autoEfficiency?.bk?.enabled ?? FALLBACK_AUTO_EFFICIENCY.bk.enabled,
      steps: autoEfficiency?.bk?.steps ?? FALLBACK_AUTO_EFFICIENCY.bk.steps,
    }),
    [autoEfficiency?.bk],
  );
  const hltRegConfig = useMemo<BrewPotAutoEfficiency>(
    () => ({
      enabled: autoEfficiency?.hlt?.enabled ?? FALLBACK_AUTO_EFFICIENCY.hlt.enabled,
      steps: autoEfficiency?.hlt?.steps ?? FALLBACK_AUTO_EFFICIENCY.hlt.steps,
    }),
    [autoEfficiency?.hlt],
  );

  // Timestamp of the last user-initiated command (see POLL_SUPPRESS_MS).
  const lastCommandTime = useRef(0);

  // Refs mirroring current state so stable callbacks read fresh values without
  // appearing in useCallback dependency arrays.
  const statesRef = useRef(states);
  statesRef.current = states;
  const priorityPotRef = useRef(priorityPot);
  priorityPotRef.current = priorityPot;
  const maxWattsRef = useRef(maxWatts);
  maxWattsRef.current = maxWatts;
  const elementWattsRef = useRef({ bk: BK_MAX_WATTS, hlt: HLT_MAX_WATTS });
  elementWattsRef.current = { bk: BK_MAX_WATTS, hlt: HLT_MAX_WATTS };

  useEffect(() => {
    let cancelled = false;

    // The rig's settings (power limits, auto-efficiency, theme) load once per
    // visit; retried from the poll loop until the rig first answers.
    const loadConfig = async (): Promise<void> => {
      if (configLoadedRef.current) return;
      try {
        const config = await api.getBrewSystemConfig();
        if (cancelled || !config.online) return;
        configLoadedRef.current = true;
        if (config.app) setRigApp(config.app);
        setRigTheme(mergeBrewTheme(config.theme));
      } catch {
        /* retried on the next successful poll */
      }
    };

    const poll = async (): Promise<void> => {
      if (Date.now() - lastCommandTime.current < POLL_SUPPRESS_MS) return;
      let status;
      try {
        status = await api.getBrewSystemState();
      } catch {
        status = null;
      }
      if (cancelled) return;

      if (status && !status.configured) {
        setConfigured(false);
        return;
      }
      if (status?.online && status.state) {
        setConfigured(true);
        setHadContact(true);
        pollFailures.current = 0;
        lastSyncRef.current = Date.now();
        setFrozenSince(null);
        void loadConfig();
        // If a command was sent while the request was in flight, discard this
        // response — it may contain stale control state.
        if (Date.now() - lastCommandTime.current < POLL_SUPPRESS_MS) return;
        const state = status.state;
        setStates((prev) => ({
          pots: {
            BK: { ...prev.pots.BK, pv: state.temperatures.bk, ...state.controlState.pots.BK },
            MLT: { ...prev.pots.MLT, pv: state.temperatures.mlt },
            HLT: { ...prev.pots.HLT, pv: state.temperatures.hlt, ...state.controlState.pots.HLT },
          },
          pumps: {
            P1: { ...prev.pumps.P1, ...state.controlState.pumps.P1 },
            P2: { ...prev.pumps.P2, ...state.controlState.pumps.P2 },
          },
        }));
        if (state.timer) setTimerState(state.timer);
      } else {
        // Rig unreachable (or our server didn't answer) — after a few misses,
        // warn loudly instead of silently showing frozen readings.
        if (status) setConfigured(true);
        pollFailures.current += 1;
        if (pollFailures.current >= CONNECTION_LOST_AFTER) {
          setFrozenSince((prev) => prev ?? lastSyncRef.current ?? Date.now());
        }
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Debounce timers for control calls — a slider drag becomes a handful of
  // requests through the tunnel instead of dozens.
  const apiTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debouncedApi = useCallback((key: string, fn: () => void, delay = 150) => {
    clearTimeout(apiTimers.current[key]);
    apiTimers.current[key] = setTimeout(fn, delay);
  }, []);

  const handlePotUpdate = useCallback(
    (potName: BrewPot, updates: PotUpdate) => {
      lastCommandTime.current = Date.now();
      const s = statesRef.current;
      const mw = maxWattsRef.current;
      const { bk: bkMaxW, hlt: hltMaxW } = elementWattsRef.current;
      const pp = priorityPotRef.current;
      if (updates.heaterOn !== undefined) {
        quiet(api.setBrewPotPower(potName, updates.heaterOn));
      }
      if (updates.regulationEnabled !== undefined) {
        quiet(api.setBrewPotRegulation(potName, updates.regulationEnabled));
      }
      if (updates.sv !== undefined) {
        const sv = updates.sv;
        debouncedApi(`sv-${potName}`, () => quiet(api.setBrewPotSv(potName, sv)));
      }
      // Compute the yielding pot's clamped efficiency so it batches into one setState.
      // The rig's backend enforces the same limit — this mirrors it for instant UI
      // feedback. When both REGs are on, BK always has priority so they don't compete.
      let yieldPot: BrewPot | null = null;
      let yieldEfficiency: number | null = null;
      const bothRegsOn = s.pots.BK.regulationEnabled && s.pots.HLT.regulationEnabled;
      if (updates.efficiency !== undefined) {
        const requested = updates.efficiency;
        if (!bothRegsOn || potName === 'BK') setPriorityPot(potName);
        debouncedApi(`eff-${potName}`, () => quiet(api.setBrewPotEfficiency(potName, requested)));
        if (potName === 'BK' && s.pots.HLT.heaterOn) {
          const usedByBk = ((s.pots.BK.heaterOn ? requested : 0) / 100) * bkMaxW;
          const newHltCap = Math.max(0, Math.min(100, ((mw - usedByBk) / hltMaxW) * 100));
          const clamped = Math.min(s.pots.HLT.efficiency, newHltCap);
          debouncedApi('eff-HLT', () => quiet(api.setBrewPotEfficiency('HLT', clamped)));
          yieldPot = 'HLT';
          yieldEfficiency = clamped;
        } else if (potName === 'HLT' && s.pots.BK.heaterOn) {
          if (bothRegsOn) {
            // BK has priority: cap HLT based on BK's current usage
            const usedByBk = (s.pots.BK.efficiency / 100) * bkMaxW;
            const newHltCap = Math.max(0, Math.min(100, ((mw - usedByBk) / hltMaxW) * 100));
            const clamped = Math.min(requested, newHltCap);
            debouncedApi(`eff-${potName}`, () => quiet(api.setBrewPotEfficiency('HLT', clamped)));
            updates = { ...updates, efficiency: clamped };
          } else {
            const usedByHlt = ((s.pots.HLT.heaterOn ? requested : 0) / 100) * hltMaxW;
            const newBkCap = Math.max(0, Math.min(100, ((mw - usedByHlt) / bkMaxW) * 100));
            const clamped = Math.min(s.pots.BK.efficiency, newBkCap);
            debouncedApi('eff-BK', () => quiet(api.setBrewPotEfficiency('BK', clamped)));
            yieldPot = 'BK';
            yieldEfficiency = clamped;
          }
        }
      }
      // When a heater is toggled, resync the yielding pot's efficiency on the rig
      if (updates.heaterOn !== undefined) {
        const newBkOn = potName === 'BK' ? updates.heaterOn : s.pots.BK.heaterOn;
        const newHltOn = potName === 'HLT' ? updates.heaterOn : s.pots.HLT.heaterOn;
        if (pp === 'BK' && newHltOn) {
          const usedByBk = ((newBkOn ? s.pots.BK.efficiency : 0) / 100) * bkMaxW;
          const newHltCap = Math.max(0, Math.min(100, ((mw - usedByBk) / hltMaxW) * 100));
          quiet(api.setBrewPotEfficiency('HLT', Math.min(s.pots.HLT.efficiency, newHltCap)));
        } else if (pp === 'HLT' && newBkOn) {
          const usedByHlt = ((newHltOn ? s.pots.HLT.efficiency : 0) / 100) * hltMaxW;
          const newBkCap = Math.max(0, Math.min(100, ((mw - usedByHlt) / bkMaxW) * 100));
          quiet(api.setBrewPotEfficiency('BK', Math.min(s.pots.BK.efficiency, newBkCap)));
        }
      }
      // Apply updates immutably; in the same pass, batch the yielding pot's clamp.
      setStates((prev) => {
        const next: PanelStates = {
          ...prev,
          pots: { ...prev.pots, [potName]: { ...prev.pots[potName], ...updates } },
        };
        if (yieldPot && yieldEfficiency !== null) {
          next.pots = {
            ...next.pots,
            [yieldPot]: { ...next.pots[yieldPot], efficiency: yieldEfficiency },
          };
        }
        return next;
      });
    },
    [debouncedApi],
  );

  const handlePumpUpdate = useCallback(
    (pumpName: BrewPump, updates: PumpUpdate) => {
      lastCommandTime.current = Date.now();
      if (updates.on !== undefined) {
        quiet(api.setBrewPumpPower(pumpName, updates.on));
      }
      if (updates.speed !== undefined) {
        // The kiosk soft-ramps pump speed client-side (a stream of tiny steps);
        // through the tunnel that would be a request flood, so the remote just
        // debounces and sends the final value.
        const speed = updates.speed;
        debouncedApi(`speed-${pumpName}`, () => quiet(api.setBrewPumpSpeed(pumpName, speed)));
      }
      setStates((prev) => ({
        ...prev,
        pumps: { ...prev.pumps, [pumpName]: { ...prev.pumps[pumpName], ...updates } },
      }));
    },
    [debouncedApi],
  );

  // Derive effective (throttled) power and slider caps — the priority pot gets its
  // requested efficiency; the other yields to fit the remaining headroom. When both
  // REGs are on, BK always has priority so HLT yields. Mirrors the rig's backend.
  const bothRegsOn = states.pots.BK.regulationEnabled && states.pots.HLT.regulationEnabled;
  const effectivePriority = bothRegsOn ? 'BK' : priorityPot;
  let bkCap: number, hltCap: number, bkEffective: number, hltEffective: number;
  let bkWatts: number, hltWatts: number;
  if (effectivePriority === 'HLT') {
    hltCap = Math.floor(Math.min(100, (maxWatts / HLT_MAX_WATTS) * 100));
    hltEffective = states.pots.HLT.heaterOn ? states.pots.HLT.efficiency : 0;
    hltWatts = Math.round((hltEffective / 100) * HLT_MAX_WATTS);
    bkCap = Math.floor(Math.max(0, Math.min(100, ((maxWatts - hltWatts) / BK_MAX_WATTS) * 100)));
    bkEffective = states.pots.BK.heaterOn ? Math.min(states.pots.BK.efficiency, bkCap) : 0;
    bkWatts = Math.round((bkEffective / 100) * BK_MAX_WATTS);
  } else {
    // BK has priority (default)
    bkCap = Math.floor(Math.min(100, (maxWatts / BK_MAX_WATTS) * 100));
    bkEffective = states.pots.BK.heaterOn ? states.pots.BK.efficiency : 0;
    bkWatts = Math.round((bkEffective / 100) * BK_MAX_WATTS);
    hltCap = Math.floor(Math.max(0, Math.min(100, ((maxWatts - bkWatts) / HLT_MAX_WATTS) * 100)));
    hltEffective = states.pots.HLT.heaterOn ? Math.min(states.pots.HLT.efficiency, hltCap) : 0;
    hltWatts = Math.round((hltEffective / 100) * HLT_MAX_WATTS);
  }
  const totalWatts = bkWatts + hltWatts;
  const isOverLimit = totalWatts > maxWatts;

  // Stable per-device callbacks — identity never changes so memo'd cards skip re-renders
  const onUpdateBK = useCallback((updates: PotUpdate) => handlePotUpdate('BK', updates), [handlePotUpdate]);
  const onUpdateMLT = useCallback(() => {}, []);
  const onUpdateHLT = useCallback((updates: PotUpdate) => handlePotUpdate('HLT', updates), [handlePotUpdate]);
  const onUpdateP1 = useCallback((updates: PumpUpdate) => handlePumpUpdate('P1', updates), [handlePumpUpdate]);
  const onUpdateP2 = useCallback((updates: PumpUpdate) => handlePumpUpdate('P2', updates), [handlePumpUpdate]);

  const themeVars = useMemo(() => buildThemeVars(rigTheme) as React.CSSProperties, [rigTheme]);

  if (configured === false) {
    return (
      <div className={styles.brewingPanel} style={themeVars}>
        <div className={styles.placeholder}>
          <div className={styles.placeholderTitle}>Brew system not configured</div>
          <div className={styles.placeholderText}>
            Set BREW_SYSTEM_URL on the server (e.g. http://&lt;brew-pi-ip&gt;:8000 in
            /etc/brewplanner.env) and restart it to connect the brewing rig.
          </div>
        </div>
      </div>
    );
  }

  if (!hadContact) {
    const offline = frozenSince != null;
    return (
      <div className={styles.brewingPanel} style={themeVars}>
        <div className={styles.placeholder}>
          <div className={styles.placeholderTitle}>
            {offline ? 'Brew system is offline' : 'Connecting to the brew system…'}
          </div>
          <div className={styles.placeholderText}>
            {offline
              ? 'The rig did not answer — it is probably powered off. This page reconnects automatically.'
              : 'Fetching live status from the brewing rig.'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.brewingPanel} style={themeVars}>
      {frozenSince != null && (
        <div className={styles.connectionBanner}>
          ⚠ Brew system unreachable — readings frozen since{' '}
          {clockTime(frozenSince, true)}. Controls are inactive.
        </div>
      )}
      <div className={`${styles.panelBody} ${frozenSince != null ? styles.offline : ''}`}>
        {/* Pot Cards Row - Strict order: BK, MLT, HLT */}
        <div className={styles.potRow}>
          <PotCard
            name="BK"
            type="BK"
            potState={states.pots.BK}
            regulationConfig={bkRegConfig}
            effectiveEfficiency={bkEffective}
            potMaxWatts={BK_MAX_WATTS}
            efficiencyCap={bkCap}
            accentBlue={rigTheme.accentBlue}
            onUpdate={onUpdateBK}
          />
          <PotCard
            name="MLT"
            type="MLT"
            potState={states.pots.MLT}
            regulationConfig={bkRegConfig}
            effectiveEfficiency={0}
            potMaxWatts={0}
            efficiencyCap={100}
            accentBlue={rigTheme.accentBlue}
            onUpdate={onUpdateMLT}
          />
          <PotCard
            name="HLT"
            type="HLT"
            potState={states.pots.HLT}
            regulationConfig={hltRegConfig}
            effectiveEfficiency={hltEffective}
            potMaxWatts={HLT_MAX_WATTS}
            efficiencyCap={hltCap}
            accentBlue={rigTheme.accentBlue}
            onUpdate={onUpdateHLT}
          />
        </div>

        {/* Pump Cards Row with Brew Timer in the middle */}
        <div className={styles.pumpRow}>
          <PumpCard
            name="Pump 1"
            pumpState={states.pumps.P1}
            accentBlue={rigTheme.accentBlue}
            bgSecondary={rigTheme.bgSecondary}
            onUpdate={onUpdateP1}
          />
          <BrewTimer timerState={timerState} />
          <PumpCard
            name="Pump 2"
            pumpState={states.pumps.P2}
            accentBlue={rigTheme.accentBlue}
            bgSecondary={rigTheme.bgSecondary}
            onUpdate={onUpdateP2}
          />
        </div>

        {/* Power readout */}
        <span className={`${styles.powerText} ${isOverLimit ? styles.powerTextOver : ''}`}>
          {totalWatts.toLocaleString()} / {maxWatts.toLocaleString()} W
        </span>
      </div>
    </div>
  );
}
