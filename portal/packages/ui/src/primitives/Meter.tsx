import { formatPercent } from '../lib/format';
import { meter } from '../recipes/meter';

export interface MeterProps {
  value: number;
  max: number;
  label: string;
  /** Ratios at which the fill turns straw and cinder. */
  warnAt?: number;
  critAt?: number;
  showValue?: boolean;
  className?: string;
}

/** Utilisation bar. The fill carries severity; the track is a lighter step of the same hue. */
export function Meter({
  value,
  max,
  label,
  warnAt = 0.8,
  critAt = 0.95,
  showValue = true,
  className,
}: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const level = ratio >= critAt ? 'crit' : ratio >= warnAt ? 'warn' : 'normal';
  const s = meter({ level });
  return (
    <div className={s.root({ className })}>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={`${formatPercent(ratio)} (${value} of ${max})`}
        className={s.track()}
      >
        <div className={s.fill()} style={{ width: `${ratio * 100}%` }} />
      </div>
      {showValue && (
        <span className={s.value()} aria-hidden>
          {formatPercent(ratio)}
        </span>
      )}
    </div>
  );
}
