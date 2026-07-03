import { memo, useEffect, useMemo, useState } from 'react';
import type { BrewPotAutoEfficiency } from '@checklist/shared';
import styles from './PotCard.module.css';
import { getTemperatureColor } from './theme';

/**
 * One brew-kettle card, ported from brew-system-v3 (PotCard.jsx) minus the
 * kiosk-only bits (touch sounds, theme context). BK and HLT are controllable;
 * MLT is a read-only temperature display.
 *
 * The regulation control loop is intentionally NOT here — the rig's backend
 * regulates, this card only displays polled state and forwards user input.
 */

export interface PotCardState {
  /** Current temperature; null when the rig reports a failed sensor. */
  pv: number | null;
  sv: number;
  efficiency: number;
  heaterOn: boolean;
  regulationEnabled: boolean;
}

export interface PotUpdate {
  heaterOn?: boolean;
  regulationEnabled?: boolean;
  sv?: number;
  efficiency?: number;
}

interface PotCardProps {
  name: string;
  type: 'BK' | 'MLT' | 'HLT';
  potState: PotCardState;
  regulationConfig: BrewPotAutoEfficiency;
  /** Duty cycle actually applied after the shared power limit, for the glow + watts. */
  effectiveEfficiency: number;
  potMaxWatts: number;
  /** Highest duty cycle the shared power limit currently allows. */
  efficiencyCap: number;
  /** Slider gradient start colour (the rig theme's accent blue). */
  accentBlue: string;
  onUpdate: (updates: PotUpdate) => void;
}

function PotCard({
  name,
  type,
  potState,
  regulationConfig,
  effectiveEfficiency,
  potMaxWatts,
  efficiencyCap,
  accentBlue,
  onUpdate,
}: PotCardProps): JSX.Element {
  const [localSV, setLocalSV] = useState(potState.sv || 75);
  const [localEfficiency, setLocalEfficiency] = useState(potState.efficiency || 0);

  useEffect(() => {
    if (potState.sv !== undefined) setLocalSV(potState.sv);
    if (potState.efficiency !== undefined) setLocalEfficiency(potState.efficiency);
  }, [potState.sv, potState.efficiency]);

  const handleTogglePower = (): void => {
    if (potState.heaterOn && potState.regulationEnabled) {
      onUpdate({ heaterOn: false, regulationEnabled: false });
    } else {
      onUpdate({ heaterOn: !potState.heaterOn });
    }
  };

  const handleToggleRegulation = (): void => {
    onUpdate({ regulationEnabled: !potState.regulationEnabled });
  };

  const handleSetTempChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = parseFloat(e.target.value);
    setLocalSV(value);
    onUpdate({ sv: value });
  };

  const handleEfficiencyChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = Math.min(parseFloat(e.target.value), efficiencyCap);
    setLocalEfficiency(value);
    onUpdate({ efficiency: value });
  };

  // Clamp the slider down when the power cap drops below the requested efficiency.
  useEffect(() => {
    if (type !== 'MLT' && localEfficiency > efficiencyCap) {
      setLocalEfficiency(efficiencyCap);
      onUpdate({ efficiency: efficiencyCap });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirror the rig UI: react to cap changes only
  }, [efficiencyCap]);

  // pv can be null when the sensor fails — show '--' rather than a fake number
  const sensorOk = potState.pv != null;
  const pvColor = sensorOk ? getTemperatureColor(potState.pv!) : 'var(--color-text-muted)';
  const svColor = getTemperatureColor(localSV);
  const glowIntensity = type !== 'MLT' && potState.heaterOn ? effectiveEfficiency / 100 : 0;
  const rawWatts = type !== 'MLT' && potState.heaterOn ? (effectiveEfficiency / 100) * potMaxWatts : 0;
  const wattsDrawn = Math.round(rawWatts / 50) * 50;
  const isThrottled = type !== 'MLT' && potState.heaterOn && effectiveEfficiency < localEfficiency;

  // Quantize glow to 5% steps so the border style only changes 20 times, not 100
  const quantizedGlow = glowIntensity > 0 ? Math.ceil(glowIntensity * 20) / 20 : 0;
  const cardStyle = useMemo(
    () =>
      ({
        '--glow-border-color':
          quantizedGlow > 0 ? `rgba(240, 76, 101, ${0.3 + quantizedGlow * 0.7})` : 'transparent',
        boxShadow: quantizedGlow > 0 ? 'none' : 'var(--shadow-card)',
      }) as React.CSSProperties,
    [quantizedGlow],
  );

  return (
    <div
      className={`${styles.potCard} ${type === 'MLT' ? styles.mlt : ''} ${quantizedGlow > 0 ? styles.glowing : ''}`}
      style={cardStyle}
    >
      <div className={styles.header}>
        <h3 className={styles.title}>{name}</h3>
        {type !== 'MLT' && (
          <div className={styles.headerControls}>
            <button
              className={`${styles.toggleBtn} ${potState.heaterOn ? styles.on : ''}`}
              onClick={handleTogglePower}
            >
              {potState.heaterOn ? 'ON' : 'OFF'}
            </button>
            <button
              className={`${styles.toggleBtn} ${styles.regBtn} ${potState.regulationEnabled ? styles.on : ''}`}
              onClick={handleToggleRegulation}
            >
              REG
            </button>
          </div>
        )}
      </div>

      <div className={styles.tempDisplay}>
        <div className={`${styles.pvSection} ${type === 'MLT' ? styles.mltTemp : ''}`}>
          {type !== 'MLT' && <div className={styles.pvLabel}>Current</div>}
          <div
            className={styles.pvValue}
            style={{ color: pvColor }}
            title={sensorOk ? undefined : 'Sensor not responding'}
          >
            {sensorOk ? `${potState.pv!.toFixed(1)}°` : '--'}
          </div>
        </div>
        {type !== 'MLT' && potState.regulationEnabled && (
          <div className={styles.svSection}>
            <div className={styles.svLabel}>Target</div>
            <div className={styles.svValue} style={{ color: svColor }}>
              {localSV.toFixed(1)}°
            </div>
          </div>
        )}
        {type !== 'MLT' && (
          <div className={styles.wattsRow}>
            <span className={`${styles.wattsValue} ${isThrottled ? styles.wattsThrottled : ''}`}>
              {wattsDrawn.toLocaleString()} W
            </span>
            {isThrottled && <span className={styles.throttleTag}>limited</span>}
          </div>
        )}
      </div>

      {type !== 'MLT' && (
        <>
          {potState.regulationEnabled && (
            <div className={styles.control}>
              <label className={styles.controlLabel}>
                Set Temperature
                <span className={styles.controlValue} style={{ color: svColor }}>
                  {localSV.toFixed(0)}°
                </span>
              </label>
              <input
                type="range"
                min="0"
                max="100"
                step="1"
                value={localSV}
                onChange={handleSetTempChange}
                className={styles.slider}
                style={{
                  background: `linear-gradient(to right,
                  ${accentBlue} 0%,
                  ${getTemperatureColor(localSV)} ${localSV}%,
                  var(--color-border-light) ${localSV}%,
                  var(--color-border-light) 100%)`,
                }}
              />
            </div>
          )}

          <div className={styles.control}>
            <label className={styles.controlLabel}>
              Efficiency
              <span className={styles.controlValue}>{localEfficiency.toFixed(0)}%</span>
            </label>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={localEfficiency}
              onChange={handleEfficiencyChange}
              className={styles.slider}
              disabled={potState.regulationEnabled && regulationConfig.enabled}
              style={{
                background: `linear-gradient(to right,
                  var(--color-gradient-warm-start) 0%,
                  var(--color-gradient-warm-end) ${localEfficiency}%,
                  var(--color-border-light) ${localEfficiency}%,
                  var(--color-border-light) 100%)`,
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

// Custom comparator: compare potState fields by VALUE, not reference, so
// sibling PotCards skip re-rendering when only one pot changed.
function potCardEqual(prev: PotCardProps, next: PotCardProps): boolean {
  if (prev.effectiveEfficiency !== next.effectiveEfficiency) return false;
  if (prev.efficiencyCap !== next.efficiencyCap) return false;
  if (prev.onUpdate !== next.onUpdate) return false;
  if (prev.regulationConfig !== next.regulationConfig) return false;
  if (prev.accentBlue !== next.accentBlue) return false;
  const ps = prev.potState;
  const ns = next.potState;
  if (ps.pv !== ns.pv) return false;
  if (ps.sv !== ns.sv) return false;
  if (ps.heaterOn !== ns.heaterOn) return false;
  if (ps.regulationEnabled !== ns.regulationEnabled) return false;
  if (ps.efficiency !== ns.efficiency) return false;
  return true;
}

export default memo(PotCard, potCardEqual);
