import { useEffect, useState } from 'react';
import type { MeResponse } from '@adminforge/schemas';

/** 59:41 · 2:05:00 · never negative. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** D6: 60 minutes unless the API says otherwise; never more than the schema allows (480). */
export const DEFAULT_ARM_MAX_MINUTES = 60;
const DURATIONS = [15, 30, 60, 120, 240, 480];

/** Duration choices up to the policy cap (the cap itself is always offered). */
export function armDurations(maxMinutes: number = DEFAULT_ARM_MAX_MINUTES): number[] {
  const cap = Math.max(5, Math.min(480, Math.floor(maxMinutes)));
  const options = DURATIONS.filter((d) => d < cap);
  return [...options, cap];
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.floor(h)} h ${minutes % 60} min`;
}

/** Five minutes before expiry the shell offers Extend. */
export const WARN_BEFORE_MS = 5 * 60_000;

export interface ArmState {
  armed: boolean;
  /** Milliseconds left; 0 when not armed. */
  remainingMs: number;
  armedUntil: Date | null;
  canExtend: boolean;
}

export type ArmSession = Pick<MeResponse, 'mode' | 'armedUntil'> & { armExtended?: boolean };

export function armStateAt(me: ArmSession, now: number): ArmState {
  const until = me.mode === 'armed' && me.armedUntil ? new Date(me.armedUntil) : null;
  const remainingMs = until ? Math.max(0, until.getTime() - now) : 0;
  const armed = remainingMs > 0;
  return { armed, remainingMs, armedUntil: armed ? until : null, canExtend: armed && !me.armExtended };
}

/** Live arm state, ticking every second while armed. */
export function useArmState(me: ArmSession): ArmState {
  const [now, setNow] = useState(() => Date.now());
  const ticking = me.mode === 'armed' && Boolean(me.armedUntil);
  useEffect(() => {
    if (!ticking) return;
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [ticking]);
  return armStateAt(me, now);
}
