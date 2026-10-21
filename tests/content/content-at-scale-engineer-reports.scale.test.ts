import path from 'node:path';
import { renderString } from '@adminforge/expressions';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// The engineer report library (Phase E) at its caps, under the API's transform budget: run in the `scale` project
// (after the other projects, one file at a time) because the budget is wall-clock. The behaviour of the same reports is
// in engineer-report-library.test.ts.

const NOW = '2026-10-17T12:00:00Z';
const USER = { oid: 'automation', upn: 'automation', name: 'Automation identity', roles: ['Portal.Reader'] };
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Def = any;
const def = (id: string): Def => {
  const found = loaded.definitions.find((d) => d.def.id === id);
  if (!found) throw new Error(`${id} is missing from portal/content`);
  return found.def;
};

// ── Large enterprise: every transform stays inside the API's 250 ms budget at its cap ─────────────────────────────
// Measured on the host (2026-10-17, under load): JSONata needs about 0.05–0.2 ms per row for a filter, a lookup or a
// mapped row, and its grouping constructor fails ("nested too deeply") once a lookup has a couple of thousand keys —
// so lookups are built with $merge (or $distinct), each list is capped where its transform still fits, and a join whose
// lookup side was cut short shows nothing rather than false findings. Each transform at its cap took at most about
// half the API's 250 ms budget there; these tests hold them to that budget plus 20 % for a test runner that shares the
// CPU with the other test files.
const SCALE_TIMEOUT_MS = 300;
const atScale = (id: string, ds: string, value: unknown, params: Record<string, unknown> = {}) =>
  renderString(
    def(id).datasources[ds].transform,
    { now: NOW, user: USER, env: {}, params, value },
    { timeoutMs: SCALE_TIMEOUT_MS },
  ) as Promise<Def>;

const guid = (n: number, prefix = '0') =>
  `${prefix.padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (offset: number) => new Date(Date.parse(NOW) + offset * 86_400_000).toISOString();

// Wall-clock budgets: a run can lose the CPU to other test files on a busy machine, so these retry before failing.
describe('scale', { retry: 2 }, () => {
  it('SAML certificate expiry: 500 SAML apps with a rollover each', async () => {
    const apps = Array.from({ length: 500 }, (_, i) => ({
      id: guid(i, 'c'),
      appId: guid(i, 'd'),
      displayName: `SAML app ${i}`,
      accountEnabled: true,
      notificationEmailAddresses: i % 2 ? ['it@example.com'] : [],
      keyCredentials: [
        { usage: 'Sign', endDateTime: day(i % 90) },
        { usage: 'Verify', endDateTime: day(i % 90) },
        { usage: 'Sign', endDateTime: day(400 + (i % 300)) },
        { usage: 'Verify', endDateTime: day(400 + (i % 300)) },
      ],
    }));
    const out = await atScale('identity.saml-certificate-expiry', 'apps', { value: apps }, { days: 60 });
    expect(out).toMatchObject({ saml: 500, capped: true });
    expect(out.rows.every((r: Def) => r.state === 'rollover')).toBe(true);
  });

  it('every list is capped where its transform fits', () => {
    const caps = {
      'identity.ca-report-only-impact': { signins: 300 },
      'endpoint.recovery-key-escrow': { devices: 2000, keys: 2000 },
      'endpoint.windows-laps-coverage': { devices: 1500, backups: 1500 },
      'identity.unused-apps': { apps: 1000, activity: 1000, grants: 2000 },
      'identity.auth-method-strength': { weak: 1000, admins: 2000 },
      'identity.licence-assignment-errors': { groups: 500, members: 500, noLocation: 500 },
      'identity.group-lifecycle': { expiring: 2000, singleOwner: 2000, paused: 2000, deleted: 2000 },
      'identity.user-attribute-completeness': { managers: 5000 },
      'identity.saml-certificate-expiry': { apps: 500 },
    };
    for (const [id, lists] of Object.entries(caps))
      for (const [ds, max] of Object.entries(lists))
        expect([id, ds, def(id).datasources[ds].maxItems]).toEqual([id, ds, max]);
  });

  it('Conditional Access impact: 300 sign-ins × 15 policies from Graph, or any number from Log Analytics', async () => {
    const results = [
      'reportOnlySuccess',
      'reportOnlyNotApplied',
      'reportOnlyInterrupted',
      'reportOnlyFailure',
    ];
    const policies = Array.from({ length: 14 }, (_, p) => ({
      id: guid(p, '9'),
      displayName: `AF-Audit: policy ${p}`,
    }));
    const signins = Array.from({ length: 300 }, (_, i) => ({
      id: `s${i}`,
      userPrincipalName: `user${i % 70}@example.com`,
      appliedConditionalAccessPolicies: [
        ...policies.map((p, j) => ({ id: p.id, result: results[(i + j) % (i % 50 === 0 ? 4 : 2)] })),
        { id: guid(99, '9'), result: 'success' },
      ],
    }));
    const out = await atScale('identity.ca-report-only-impact', 'report', { policies, signins, kql: null });
    expect(out).toMatchObject({ policies: 14, signins: 300, capped: true, source: 'graph' });
    const kql = policies.map((p, i) => ({
      PolicyId: p.id,
      WouldBlock: i,
      WouldPrompt: 2,
      WouldAllow: 1000,
      NotApplied: 50_000,
      People: i,
    }));
    const fromKql = await atScale('identity.ca-report-only-impact', 'report', {
      policies,
      kql,
      total: 120_000,
    });
    expect(fromKql).toMatchObject({ source: 'logAnalytics', capped: false, signins: 120_000, blocking: 13 });
    expect(fromKql.rows[0]).toMatchObject({ wouldBlock: 13, people: 13, verdict: 'blocks' });
  });

  it('BitLocker escrow: 2,000 devices and 1,999 keys, and nothing when the keys were cut short', async () => {
    const devices = Array.from({ length: 2000 }, (_, i) => ({
      id: guid(i, '1'),
      deviceName: `EX-LT-${i}`,
      azureADDeviceId: guid(i, '2'),
      isEncrypted: i % 10 !== 0,
      lastSyncDateTime: day(-(i % 60)),
    }));
    const keys = Array.from({ length: 1999 }, (_, i) => ({
      deviceId: guid(i % 7 === 0 ? i + 1_000_000 : i, '2'),
      volumeType: 'operatingSystemVolume',
      createdDateTime: day(-100),
    }));
    const out = await atScale('endpoint.recovery-key-escrow', 'report', { devices, keys }, { staleDays: 30 });
    expect(out.missing).toBeGreaterThan(100);
    expect(out.devicesCapped).toBe(true);
    const capped = await atScale('endpoint.recovery-key-escrow', 'report', {
      devices,
      keys: [...keys, keys[0]],
    });
    expect(capped).toMatchObject({ rows: [], missing: null, keysCapped: true });
  });

  it('Windows LAPS: 1,500 devices and 1,499 backups, and nothing when the backups were cut short', async () => {
    const devices = Array.from({ length: 1500 }, (_, i) => ({
      id: guid(i, '3'),
      deviceId: guid(i, '4'),
      displayName: `EX-LT-${i}`,
      trustType: i % 5 ? 'AzureAd' : 'ServerAd',
      approximateLastSignInDateTime: day(-(i % 25)),
    }));
    const backups = Array.from({ length: 1499 }, (_, i) => ({
      id: guid(i, '4'),
      lastBackupDateTime: day(-(i % 40)),
    }));
    const out = await atScale(
      'endpoint.windows-laps-coverage',
      'report',
      { devices, backups },
      { days: 30, activeDays: 30 },
    );
    expect(out.stale).toBeGreaterThan(0);
    const capped = await atScale('endpoint.windows-laps-coverage', 'report', {
      devices,
      backups: [...backups, backups[0]],
    });
    expect(capped).toMatchObject({ rows: [], never: null, backupsCapped: true });
  });

  it('unused apps: 1,000 apps, 999 sign-in records, 2,000 Graph grants, and nothing when activity was cut short', async () => {
    const apps = Array.from({ length: 1000 }, (_, i) => ({
      id: guid(i, '5'),
      appId: guid(i, '6'),
      displayName: `App ${i}`,
      appOwnerOrganizationId: i % 3 ? guid(1, 'e') : guid(2, 'e'),
      accountEnabled: true,
      createdDateTime: day(-400),
    }));
    const activity = Array.from({ length: 999 }, (_, i) => ({
      appId: guid(i, '6'),
      lastSignInActivity: { lastSignInDateTime: day(-(i % 200)) },
    }));
    const grants = Array.from({ length: 2000 }, (_, i) => ({ principalId: guid(i % 500, '5') }));
    const out = await atScale(
      'identity.unused-apps',
      'report',
      { org: guid(1, 'e'), apps, activity, grants },
      { days: 90 },
    );
    expect(out.total).toBeGreaterThan(300);
    expect(out.rows[0].holdsPermissions).toBe(true);
    const capped = await atScale('identity.unused-apps', 'report', {
      org: guid(1, 'e'),
      apps,
      activity: [...activity, activity[0]],
      grants,
    });
    expect(capped).toMatchObject({ rows: [], activityCapped: true });
  });

  it('authentication method strength, licence errors, group lifecycle and managers at their caps', async () => {
    const weak = Array.from({ length: 1000 }, (_, i) => ({
      id: guid(i, '7'),
      userPrincipalName: `u${i}@example.com`,
      userDisplayName: `User ${i}`,
      isAdmin: i % 500 === 0,
      methodsRegistered: i % 4 ? ['mobilePhone', 'microsoftAuthenticatorPush'] : ['mobilePhone'],
    }));
    expect(await atScale('identity.auth-method-strength', 'report', { weak, admins: [] })).toMatchObject({
      weakOnly: 250,
      capped: true,
    });
    const users = Array.from({ length: 2000 }, (_, i) => ({
      id: guid(i, '8'),
      displayName: `User ${i}`,
      userPrincipalName: `u${i}@example.com`,
      accountEnabled: true,
      assignedLicenses: [{ skuId: 'sku-1' }],
    }));
    const licGroups = Array.from({ length: 500 }, (_, i) => ({
      id: guid(i, 'b'),
      displayName: `LIC-${i}`,
      assignedLicenses: [{ skuId: 'sku-1' }],
    }));
    const failedMembers = users.slice(0, 500).map((u) => ({
      ...u,
      licenseAssignmentStates: [
        { skuId: 'sku-1', assignedByGroup: guid(1, 'b'), state: 'Error', error: 'CountViolation' },
      ],
    }));
    const lic = await atScale(
      'identity.licence-assignment-errors',
      'report',
      {
        groups: licGroups,
        members: failedMembers,
        noLocation: users.slice(0, 500),
        skus: [{ skuId: 'sku-1', skuPartNumber: 'SPE_E5' }],
      },
      { group: guid(1, 'b') },
    );
    expect(lic).toMatchObject({
      groups: 500,
      errors: 500,
      noLocation: 500,
      capped: true,
      groupsCapped: true,
    });
    const groups = users.map((u, i) => ({
      id: u.id,
      displayName: `Group ${i}`,
      groupTypes: [],
      securityEnabled: true,
    }));
    const life = await atScale(
      'identity.group-lifecycle',
      'report',
      { policy: [], expiring: [], singleOwner: groups, paused: [], deleted: [] },
      { issue: 'all' },
    );
    expect(life).toMatchObject({ singleOwner: 2000, capped: true });
    const members = Array.from({ length: 5000 }, (_, i) => ({
      id: guid(i, 'a'),
      displayName: `User ${i}`,
      userPrincipalName: `u${i}@example.com`,
      ...(i % 10 ? { manager: { displayName: 'M', accountEnabled: i % 7 !== 0 } } : {}),
    }));
    expect(
      await atScale('identity.user-attribute-completeness', 'managers', { value: members }),
    ).toMatchObject({
      noManager: 500,
      capped: true,
    });
  });
});
