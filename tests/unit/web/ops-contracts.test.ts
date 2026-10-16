import { appearance, probes, scheduleRuns, schedules } from '../../support/web/fixtures/automation';
import {
  accentChecks,
  AppearanceResponse,
  bodyFor,
  draftFrom,
  isHex,
} from '@adminforge/web/src/ops/appearance';
import { auditCsv, readAuditEvent, resultTone } from '@adminforge/web/src/ops/audit';
import { readProbe, readSchedule, readScheduleRun, runStatusView } from '@adminforge/web/src/ops/schedules';

describe('appearance', () => {
  it('rejects accents under 4.5:1 and accepts good ones', () => {
    expect(accentChecks('steel', '#2A3440').some((c) => !c.ok)).toBe(true);
    expect(accentChecks('steel', '#9CC2FF').every((c) => c.ok)).toBe(true);
    expect(accentChecks('daylight', '#2E5FA8').every((c) => c.ok)).toBe(true);
    expect(isHex('#12345G')).toBe(false);
  });

  it('a publish only sends what differs from the shipped tokens and keeps other stored tokens', () => {
    const state = AppearanceResponse.parse({
      ...appearance(),
      overrides: { steel: { accent: '#8FB4F0', focus: '#A9C4F5' } },
    });
    const draft = draftFrom(state);
    expect(draft.accents.steel).toBe('#8FB4F0');
    expect(bodyFor({ ...draft, radiusScale: 1.25, density: 'compact' }, state)).toEqual({
      version: 3,
      overrides: {
        steel: { focus: '#A9C4F5', accent: '#8FB4F0', 'radius-scale': 1.25 },
        daylight: { 'radius-scale': 1.25 },
        contrast: { 'radius-scale': 1.25 },
      },
      density: 'compact',
    });
  });
});

describe('schedules and probes', () => {
  it('reads schedules and history rows', () => {
    const s = readSchedule(schedules().items[3])!;
    expect(s).toMatchObject({
      key: 'identity.disable-stale-guests',
      writeCapable: true,
      enabled: false,
      identity: 'automation',
    });
    const run = readScheduleRun(scheduleRuns('reports.app-credential-expiry').items[0])!;
    expect(run.artifact).toEqual({
      name: 'app-credential-expiry-2026-10-12.xlsx',
      href: '/api/schedules/reports.app-credential-expiry/artifacts/sr-1',
      size: 48211,
    });
    expect(runStatusView('failed').tone).toBe('crit');
    expect(runStatusView(null).label).toBe('Never run');
  });

  it('probes: days-remaining metrics are worse when lower', () => {
    const items = probes().items.map(readProbe);
    expect(items.find((p) => p?.kind === 'certExpiry')?.thresholds.worse).toBe('lower');
    expect(items.find((p) => p?.kind === 'graph')?.thresholds.worse).toBe('higher');
    expect(items.find((p) => p?.key === 'probes.function-hr-sync-health')?.latest).toBeNull();
  });
});

describe('audit', () => {
  it('reads events and exports CSV that spreadsheets won’t execute', () => {
    const e = readAuditEvent({
      seq: 1,
      ts: '2026-10-15T14:00:00Z',
      action: '=cmd|calc',
      actorUpn: 'a@example.com',
      result: 'success',
    })!;
    expect(auditCsv([e]).split('\r\n')[1]).toContain(`"'=cmd|calc"`);
    expect(resultTone('denied')).toBe('warn');
    expect(readAuditEvent({ seq: 'x' })).toBeNull();
  });
});
