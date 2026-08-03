'use strict';

/**
 * Brew-rig control and readings, via the BrewPlanner server's
 * /api/brew-system/* proxy (see apps/server/src/routes/brewSystem.ts).
 *
 * The proxy wraps reads in a { configured, online, ... } envelope because the
 * rig is normally powered off between brew sessions; the helpers below turn that
 * envelope into a spoken-friendly error instead of making every function
 * repeat the check. Control POSTs answer 502 with a human-readable message
 * when the rig is off — apiCall throws that message and the Realtime client
 * relays it, so no envelope handling is needed there.
 */

// ── Format helpers ──────────────────────────────────────────────────────────

function formatTemp(value) {
  return value != null ? `${value.toFixed(1)}°C` : 'unavailable';
}

/** Unwrap a proxied read's availability envelope, throwing spoken-friendly errors. */
function unwrap(res) {
  if (!res.configured) {
    throw new Error('The brew system link is not configured on the BrewPlanner server.');
  }
  if (!res.online) {
    throw new Error('The brew system is offline — it is probably powered off.');
  }
  return res;
}

// ── Register brew-system functions on Bruce ─────────────────────────────────

function register(bruce, apiCall) {
  async function getRigState() {
    return unwrap(await apiCall('GET', '/api/brew-system/state')).state;
  }

  // ── Countdown watch: announce when the brew timer hits zero ─────────────
  //
  // When Bruce starts a countdown he schedules one state check for just after
  // the expected end (no continuous polling — the rig is often powered off and
  // every probe would wait out the proxy timeout). If the timer was paused in
  // the meantime, he re-checks every 15 s; if it was reset, the rig went
  // offline, or the watch has run for 4 h, he gives up silently. A restart of
  // Bruce forgets the watch — the reminder system is the durable path.

  let timerWatch = null; // { startedAt, errors, timeout }

  function clearTimerWatch() {
    if (timerWatch) {
      clearTimeout(timerWatch.timeout);
      timerWatch = null;
    }
  }

  function scheduleTimerCheck(delayMs) {
    timerWatch.timeout = setTimeout(checkTimer, delayMs);
  }

  async function checkTimer() {
    const watch = timerWatch;
    if (!watch) return;

    let res;
    try {
      res = await apiCall('GET', '/api/brew-system/state');
    } catch {
      if (timerWatch !== watch) return;
      watch.errors = (watch.errors || 0) + 1;
      if (watch.errors >= 3) {
        console.log('[Bruce] Timer watch abandoned — BrewPlanner server unreachable');
        timerWatch = null;
      } else {
        scheduleTimerCheck(10000);
      }
      return;
    }
    if (timerWatch !== watch) return; // watch replaced/cleared while fetching

    const timer = res.configured && res.online ? res.state?.timer : null;
    if (!timer || timer.target === 0) {
      // Rig off, or timer reset / switched to stopwatch — nothing to announce.
      timerWatch = null;
      return;
    }

    if (timer.seconds === 0 && !timer.running) {
      timerWatch = null;
      console.log('[Bruce] Brew timer finished — announcing');
      bruce.speak('[SYSTEM] The brew timer has just reached zero. Tell the user their brew timer is done — one short sentence, nothing else.');
      return;
    }

    if (Date.now() - watch.startedAt > 4 * 3600 * 1000) {
      console.log('[Bruce] Timer watch abandoned after 4 hours');
      timerWatch = null;
      return;
    }

    // Still counting down (someone restarted/extended it) → check again right
    // after the new expected end; paused → peek every 15 s.
    scheduleTimerCheck(timer.running ? Math.max(timer.seconds * 1000 + 1500, 3000) : 15000);
  }

  function startTimerWatch(totalSeconds) {
    clearTimerWatch();
    timerWatch = { startedAt: Date.now(), errors: 0, timeout: null };
    scheduleTimerCheck(totalSeconds * 1000 + 1500);
  }

  // ── Temperature reading ─────────────────────────────────────────────────

  bruce.registerFunction(
    'get_temperatures',
    'Get current temperature readings from all three brew-system sensors (BK, MLT, HLT)',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const t = (await getRigState()).temperatures || {};
      return `BK: ${formatTemp(t.bk)}, MLT: ${formatTemp(t.mlt)}, HLT: ${formatTemp(t.hlt)}`;
    }
  );

  // ── Full state ──────────────────────────────────────────────────────────

  bruce.registerFunction(
    'get_full_state',
    'Get full brew-system state including temperatures, heater status, and pump status',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const state = await getRigState();
      const t = state.temperatures || {};
      const cs = state.controlState || {};
      const pots = cs.pots || {};
      const pumps = cs.pumps || {};

      const lines = [];
      lines.push(`Temperatures — BK: ${formatTemp(t.bk)}, MLT: ${formatTemp(t.mlt)}, HLT: ${formatTemp(t.hlt)}`);

      for (const pot of ['BK', 'HLT']) {
        const p = pots[pot] || {};
        lines.push(`${pot}: heater ${p.heaterOn ? 'ON' : 'OFF'}, target ${p.sv ?? '?'}°C, efficiency ${p.efficiency ?? '?'}%, regulation ${p.regulationEnabled ? 'ON' : 'OFF'}`);
      }

      for (const pump of ['P1', 'P2']) {
        const pm = pumps[pump] || {};
        lines.push(`${pump}: ${pm.on ? 'ON' : 'OFF'}, speed ${pm.speed ?? '?'}%`);
      }

      return lines.join('. ');
    }
  );

  // ── Pot power ───────────────────────────────────────────────────────────

  bruce.registerFunction(
    'set_pot_power',
    'Turn a heating pot ON or OFF. Pot must be BK (boil kettle) or HLT (hot liquor tank).',
    {
      type: 'object',
      properties: {
        pot: { type: 'string', enum: ['BK', 'HLT'], description: 'Which pot' },
        on: { type: 'boolean', description: 'true to turn on, false to turn off' },
      },
      required: ['pot', 'on'],
    },
    async ({ pot, on }) => {
      await apiCall('POST', `/api/brew-system/pot/${pot}/power`, { on });
      return `${pot} heater turned ${on ? 'ON' : 'OFF'}.`;
    }
  );

  // ── Pot target temperature ──────────────────────────────────────────────

  bruce.registerFunction(
    'set_pot_target_temperature',
    'Set the target temperature (set value) for a pot. Range 0–100°C.',
    {
      type: 'object',
      properties: {
        pot: { type: 'string', enum: ['BK', 'HLT'], description: 'Which pot' },
        value: { type: 'number', description: 'Target temperature in °C (0–100)' },
      },
      required: ['pot', 'value'],
    },
    async ({ pot, value }) => {
      await apiCall('POST', `/api/brew-system/pot/${pot}/sv`, { value });
      await apiCall('POST', `/api/brew-system/pot/${pot}/regulation`, { enabled: true });
      return `${pot} target temperature set to ${value}°C with regulation enabled.`;
    }
  );

  // ── Pot efficiency ──────────────────────────────────────────────────────

  bruce.registerFunction(
    'set_pot_efficiency',
    'Set the heating element power/efficiency (PWM duty cycle) for a pot. Range 0–100%.',
    {
      type: 'object',
      properties: {
        pot: { type: 'string', enum: ['BK', 'HLT'], description: 'Which pot' },
        value: { type: 'number', description: 'Efficiency percentage (0–100)' },
      },
      required: ['pot', 'value'],
    },
    async ({ pot, value }) => {
      await apiCall('POST', `/api/brew-system/pot/${pot}/power`, { on: true });
      await apiCall('POST', `/api/brew-system/pot/${pot}/efficiency`, { value });
      return `${pot} turned on with efficiency set to ${value}%.`;
    }
  );

  // ── Pot regulation ──────────────────────────────────────────────────────

  bruce.registerFunction(
    'set_pot_regulation',
    'Enable or disable automatic temperature regulation for a pot. When enabled, the system automatically adjusts heating power to reach the target temperature.',
    {
      type: 'object',
      properties: {
        pot: { type: 'string', enum: ['BK', 'HLT'], description: 'Which pot' },
        enabled: { type: 'boolean', description: 'true to enable, false to disable' },
      },
      required: ['pot', 'enabled'],
    },
    async ({ pot, enabled }) => {
      await apiCall('POST', `/api/brew-system/pot/${pot}/regulation`, { enabled });
      return `${pot} auto-regulation ${enabled ? 'enabled' : 'disabled'}.`;
    }
  );

  // ── Pump power ──────────────────────────────────────────────────────────

  bruce.registerFunction(
    'set_pump_power',
    'Turn a pump ON or OFF. Pump must be P1 or P2.',
    {
      type: 'object',
      properties: {
        pump: { type: 'string', enum: ['P1', 'P2'], description: 'Which pump' },
        on: { type: 'boolean', description: 'true to turn on, false to turn off' },
      },
      required: ['pump', 'on'],
    },
    async ({ pump, on }) => {
      await apiCall('POST', `/api/brew-system/pump/${pump}/power`, { on });
      return `Pump ${pump} turned ${on ? 'ON' : 'OFF'}.`;
    }
  );

  // ── Pump speed ──────────────────────────────────────────────────────────

  bruce.registerFunction(
    'set_pump_speed',
    'Set the speed of a pump. Range 0–100%.',
    {
      type: 'object',
      properties: {
        pump: { type: 'string', enum: ['P1', 'P2'], description: 'Which pump' },
        value: { type: 'number', description: 'Speed percentage (0–100)' },
      },
      required: ['pump', 'value'],
    },
    async ({ pump, value }) => {
      await apiCall('POST', `/api/brew-system/pump/${pump}/power`, { on: true });
      await apiCall('POST', `/api/brew-system/pump/${pump}/speed`, { value });
      return `Pump ${pump} turned on with speed set to ${value}%.`;
    }
  );

  // ── Power draw ─────────────────────────────────────────────────────────

  bruce.registerFunction(
    'get_power_draw',
    'Get the current power draw (watts) of the brew system, broken down by BK and HLT.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      // Element wattages live in the rig's config — fetched alongside the state
      // so this stays in sync with what the rig enforces.
      const [state, config] = await Promise.all([
        getRigState(),
        apiCall('GET', '/api/brew-system/config').catch(() => null),
      ]);
      const bkMaxWatts = config?.app?.bk_element_watts ?? 8500;
      const hltMaxWatts = config?.app?.hlt_element_watts ?? 5000;
      const pots = state.controlState?.pots || {};
      const bk = pots.BK || {};
      const hlt = pots.HLT || {};
      const bkWatts = bk.heaterOn ? Math.round((bk.efficiency / 100) * bkMaxWatts) : 0;
      const hltWatts = hlt.heaterOn ? Math.round((hlt.efficiency / 100) * hltMaxWatts) : 0;
      const total = bkWatts + hltWatts;
      return `Total power draw: ${total.toLocaleString()} watts. BK: ${bkWatts.toLocaleString()} W, HLT: ${hltWatts.toLocaleString()} W.`;
    }
  );

  // ── Brew timer ────────────────────────────────────────────────────────

  bruce.registerFunction(
    'control_timer',
    'Start, stop, or reset the brew timer. Use "start" to begin a stopwatch, "stop" to pause, "reset" to zero it out. To start a countdown timer from a specific duration, use "start" and provide hours/minutes/seconds (e.g. "start the timer from 60 minutes" or "start the timer at 2 minutes and 40 seconds").',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'reset'], description: 'Timer action' },
        hours: { type: 'number', description: 'Countdown hours (optional, only used with start)' },
        minutes: { type: 'number', description: 'Countdown minutes (optional, only used with start)' },
        seconds: { type: 'number', description: 'Countdown seconds (optional, only used with start)' },
      },
      required: ['action'],
    },
    async ({ action, hours = 0, minutes = 0, seconds = 0 }) => {
      const totalSeconds = Math.round(hours * 3600 + minutes * 60 + seconds);

      if (action === 'start' && totalSeconds > 0) {
        await apiCall('POST', '/api/brew-system/timer', { action: 'set', seconds: totalSeconds });
        await apiCall('POST', '/api/brew-system/timer', { action: 'start' });
        startTimerWatch(totalSeconds);
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        const parts = [];
        if (h > 0) parts.push(`${h} hour${h !== 1 ? 's' : ''}`);
        if (m > 0) parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
        if (s > 0) parts.push(`${s} second${s !== 1 ? 's' : ''}`);
        return `Countdown timer started from ${parts.join(' and ')}.`;
      }

      const res = await apiCall('POST', '/api/brew-system/timer', { action });
      if (action === 'reset') clearTimerWatch();
      const secs = res?.timer?.seconds ?? 0;
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      const timeStr = h > 0 ? `${h} hours ${m} minutes ${s} seconds` : m > 0 ? `${m} minutes ${s} seconds` : `${s} seconds`;
      if (action === 'reset') return 'Brew timer reset to zero.';
      if (action === 'stop') return `Brew timer stopped at ${timeStr}.`;
      return `Brew timer started at ${timeStr}.`;
    }
  );

  // ── Average temperature ────────────────────────────────────────────────

  bruce.registerFunction(
    'get_average_temperature',
    'Get the average temperature of a specific brew-system pot (BK, MLT, or HLT) over the last N minutes. If the requested time range exceeds available session data, the response will include the actual available range and the average will be computed over that range instead.',
    {
      type: 'object',
      properties: {
        pot: { type: 'string', enum: ['BK', 'MLT', 'HLT'], description: 'Which pot to get the average temperature for' },
        minutes: { type: 'number', description: 'Number of minutes to look back (e.g. 5 for last 5 minutes)' },
      },
      required: ['pot', 'minutes'],
    },
    async ({ pot, minutes }) => {
      const res = unwrap(
        await apiCall('GET', `/api/brew-system/temperature/average?pot=${pot}&minutes=${minutes}`)
      );

      if (res.average == null) {
        if (res.minutes_available === 0) return 'No temperature data available yet for this brew session.';
        return `No ${pot} readings found in the last ${minutes} minute${minutes !== 1 ? 's' : ''}.`;
      }

      const capped = minutes > res.minutes_available;
      const rangeUsed = capped ? res.minutes_available : minutes;
      let reply = `The average ${pot} temperature over the last ${rangeUsed} minute${rangeUsed !== 1 ? 's' : ''} is ${res.average.toFixed(1)}°C (based on ${res.sample_count} readings).`;
      if (capped) {
        reply += ` Note: only ${res.minutes_available} minutes of session data were available, so that's the range used.`;
      }
      return reply;
    }
  );
}

module.exports = { register };
