import { SHED_LOAD, ShedLog } from '@adminforge/api/src/errors';

// A flood of refused sign-in starts (503 signin_busy) is expected load shedding: logged at info without a stack, and
// one warning a minute says it is happening and how many were refused since the last one.
describe('shed-load refusals', () => {
  it('signin_busy is shed load', () => {
    expect(SHED_LOAD.has('signin_busy')).toBe(true);
    expect(SHED_LOAD.has('internal')).toBe(false);
  });

  it('warns for the first refusal, then at most once a minute with the count', () => {
    const log = new ShedLog();
    const warned: number[] = [];
    const t0 = Date.parse('2026-10-21T08:00:00Z');
    for (let s = 0; s < 150; s++) log.refused('signin_busy', (n) => warned.push(n), t0 + s * 1000);
    expect(warned).toEqual([1, 60, 60]);
  });
});
