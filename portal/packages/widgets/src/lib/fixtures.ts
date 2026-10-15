/** Shared bits for widget fixtures: synthetic data only (Example Org, example.com, generated GUIDs). */
export const FIXTURE_NOW = Date.parse('2026-10-15T14:00:00.000Z');
export const ago = (ms: number) => new Date(FIXTURE_NOW - ms).toISOString();
export const ahead = (ms: number) => new Date(FIXTURE_NOW + ms).toISOString();
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Deterministic GUID-shaped ids: guid(7) → 0a1b2c3d-0000-4000-8000-000000000007. */
export const guid = (n: number) => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`;
