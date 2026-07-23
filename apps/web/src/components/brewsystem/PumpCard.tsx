import { memo, useEffect, useState } from 'react';
import type { BrewPumpControl } from '@checklist/shared';
import styles from './PumpCard.module.css';

/**
 * One pump card, ported from brew-system-v3 (PumpCard.jsx) minus the kiosk-only
 * bits (touch sounds, theme context — the two theme colours arrive as props).
 */

export interface PumpUpdate {
  on?: boolean;
  speed?: number;
}

interface PumpCardProps {
  name: string;
  pumpState: BrewPumpControl;
  /** Rig theme colours for the spinning-gear icon. */
  accentBlue: string;
  bgSecondary: string;
  onUpdate: (updates: PumpUpdate) => void;
}

function PumpCard({ name, pumpState, accentBlue, bgSecondary, onUpdate }: PumpCardProps): JSX.Element {
  const [localSpeed, setLocalSpeed] = useState(pumpState.speed || 0);

  useEffect(() => {
    setLocalSpeed(pumpState.speed);
  }, [pumpState.speed]);

  const handleTogglePower = (): void => {
    const turningOn = !pumpState.on;
    const updates: PumpUpdate = { on: turningOn };
    if (turningOn && (pumpState.speed || 0) === 0) {
      updates.speed = 50;
      setLocalSpeed(50);
    }
    onUpdate(updates);
  };

  const handleSpeedChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = parseFloat(e.target.value);
    setLocalSpeed(value);
    onUpdate({ speed: value });
  };

  return (
    <div className={styles.pumpCard}>
      <div className={styles.header}>
        <h3 className={styles.title}>{name}</h3>
        {pumpState.on && (
          <svg
            className={styles.gearIcon}
            style={{
              animationDuration: `${Math.max(0.3, 3 - (localSpeed / 100) * 2.7)}s`,
              animationPlayState: localSpeed === 0 ? 'paused' : 'running',
            }}
            viewBox="0 0 100 100"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M50,10 L54,20 L46,20 Z M50,90 L54,80 L46,80 Z M10,50 L20,54 L20,46 Z M90,50 L80,54 L80,46 Z M23,23 L29,29 L23,35 Z M77,77 L71,71 L77,65 Z M77,23 L71,29 L77,35 Z M23,77 L29,71 L23,65 Z"
              fill={accentBlue}
            />
            <circle cx="50" cy="50" r="25" fill={bgSecondary} stroke={accentBlue} strokeWidth="8" />
            <circle cx="50" cy="50" r="8" fill={accentBlue} />
          </svg>
        )}
        <button
          className={`${styles.toggleBtn} ${pumpState.on ? styles.on : ''}`}
          onClick={handleTogglePower}
        >
          {pumpState.on ? 'ON' : 'OFF'}
        </button>
      </div>

      <div className={styles.control}>
        <label className={styles.controlLabel}>
          Pump Speed
          <span className={styles.controlValue}>{localSpeed.toFixed(0)}%</span>
        </label>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={localSpeed}
          onChange={handleSpeedChange}
          className={styles.slider}
          style={{
            background: `linear-gradient(to right,
              var(--color-gradient-cool-start) 0%,
              var(--color-gradient-cool-end) ${localSpeed}%,
              var(--color-border-light) ${localSpeed}%,
              var(--color-border-light) 100%)`,
          }}
        />
      </div>
    </div>
  );
}

function pumpCardEqual(prev: PumpCardProps, next: PumpCardProps): boolean {
  if (prev.onUpdate !== next.onUpdate) return false;
  if (prev.accentBlue !== next.accentBlue || prev.bgSecondary !== next.bgSecondary) return false;
  const ps = prev.pumpState;
  const ns = next.pumpState;
  return ps.on === ns.on && ps.speed === ns.speed;
}

export default memo(PumpCard, pumpCardEqual);
