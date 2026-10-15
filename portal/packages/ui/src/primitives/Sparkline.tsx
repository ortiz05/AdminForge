import { useId } from 'react';
import { cn } from '../recipes/tv';

export interface SparklineProps {
  data: number[];
  /** Accessible summary, e.g. "Sign-ins, last 12 days, rising from 410 to 520". */
  label: string;
  width?: number;
  height?: number;
  /** Line colour: muted steel by default; the last point is always temper blue. */
  tone?: 'muted' | 'accent';
  className?: string;
}

/** A 2 px trend line with a 10 % wash and an accent end-dot. Pure SVG: no chart runtime needed. */
export function Sparkline({
  data,
  label,
  width = 120,
  height = 32,
  tone = 'muted',
  className,
}: SparklineProps) {
  const gradientId = useId();
  const pad = 3;
  if (data.length < 2) {
    return (
      <span
        role="img"
        aria-label={label}
        className={cn('inline-block', className)}
        style={{ width, height }}
      />
    );
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const points = data.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${points.join(' L')}`;
  const area = `${line} L${x(data.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;
  const last = data[data.length - 1]!;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn('shrink-0 overflow-visible', tone === 'accent' ? 'text-accent' : 'text-fg-3', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={x(data.length - 1)}
        cy={y(last)}
        r={3}
        className="fill-accent stroke-panel"
        strokeWidth={1.5}
      />
    </svg>
  );
}
