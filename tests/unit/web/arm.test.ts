import {
  armDurations,
  armStateAt,
  formatMinutes,
  formatRemaining,
  WARN_BEFORE_MS,
} from '@adminforge/web/src/app/arm';

describe('formatRemaining', () => {
  it('formats minutes and seconds', () => expect(formatRemaining(59 * 60_000 + 41_000)).toBe('59:41'));
  it('pads seconds', () => expect(formatRemaining(47 * 60_000 + 2_000)).toBe('47:02'));
  it('formats hours when needed', () => expect(formatRemaining(2 * 3_600_000 + 5 * 60_000)).toBe('2:05:00'));
  it('never goes negative', () => expect(formatRemaining(-5_000)).toBe('0:00'));
  it('rounds partial seconds down', () => expect(formatRemaining(59_999)).toBe('0:59'));
});

describe('armDurations', () => {
  it('offers the standard steps below the cap, plus the cap itself', () => {
    expect(armDurations(60)).toEqual([15, 30, 60]);
    expect(armDurations(240)).toEqual([15, 30, 60, 120, 240]);
    expect(armDurations(45)).toEqual([15, 30, 45]);
  });
  it('defaults to the D6 policy of 60 minutes', () => expect(armDurations()).toEqual([15, 30, 60]));
  it('clamps to the contract range (5–480)', () => {
    expect(armDurations(1)).toEqual([5]);
    expect(armDurations(10_000).at(-1)).toBe(480);
  });
});

describe('formatMinutes', () => {
  it('reads naturally', () => {
    expect(formatMinutes(15)).toBe('15 minutes');
    expect(formatMinutes(60)).toBe('1 hour');
    expect(formatMinutes(240)).toBe('4 hours');
    expect(formatMinutes(90)).toBe('1 h 30 min');
  });
});

describe('armStateAt', () => {
  const now = Date.parse('2026-10-15T14:00:00Z');
  const until = new Date(now + 47 * 60_000 + 12_000).toISOString();

  it('is read-only without an armed session', () => {
    expect(armStateAt({ mode: 'read', armedUntil: null, armExtended: false }, now)).toEqual({
      armed: false,
      remainingMs: 0,
      armedUntil: null,
      canExtend: false,
    });
  });

  it('counts down while armed and allows one extension', () => {
    const s = armStateAt({ mode: 'armed', armedUntil: until, armExtended: false }, now);
    expect(s.armed).toBe(true);
    expect(formatRemaining(s.remainingMs)).toBe('47:12');
    expect(s.canExtend).toBe(true);
    expect(armStateAt({ mode: 'armed', armedUntil: until, armExtended: true }, now).canExtend).toBe(false);
  });

  it('treats an expired window as disarmed', () => {
    const s = armStateAt({ mode: 'armed', armedUntil: until }, Date.parse(until) + 1);
    expect(s).toMatchObject({ armed: false, remainingMs: 0, canExtend: false });
  });

  it('warns five minutes before expiry', () => expect(WARN_BEFORE_MS).toBe(5 * 60_000));
});
