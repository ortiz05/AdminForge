import path from 'node:path';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// A definition's title, summary and description are what people read in the portal (catalogues, Schedules,
// Monitoring), and the UI doesn't show configuration key names (CLAUDE.md rule 10: env keys only in setup errors meant
// for administrators). `billing.month-close` said it mailed "AF_FINANCE_RECIPIENTS when it and AF_MAIL_SENDER are
// configured"; it says what to configure in words now.
//
// A ratchet: the definitions below still name keys the same way (docs/backlog.md). The list only shrinks — reword one,
// bump its version and take it off; a new definition can't join it.
const STILL_NAMING_KEYS = new Set([
  'identity.remove-group-members',
  'probes.activity-failed-writes-spike',
  'probes.arm-subscription-access',
  'probes.avd-connection-errors',
  'probes.dns-mx',
  'probes.dns-spf',
  'probes.exchange-autodiscover-service',
  'probes.exchange-mail-flow',
  'probes.resources-missing-required-tags',
  'probes.sharepoint-endpoint',
  'probes.sharepoint-file-round-trip',
  'probes.sign-in-health-adminforge',
  'probes.teams-channels',
  'probes.teams-online-meeting',
  'reports.advisor-recommendations-weekly',
  'reports.app-service-security-weekly',
  'reports.arc-agent-health-weekly',
  'reports.azure-budgets-daily',
  'reports.azure-monthly-cost-weekly',
  'reports.azure-policy-compliance-weekly',
  'reports.custom-role-risks-weekly',
  'reports.databases-public-access-weekly',
  'reports.defender-plan-coverage-weekly',
  'reports.key-vault-configuration-weekly',
  'reports.orphaned-resources-weekly',
  'reports.orphaned-role-assignments-weekly',
  'reports.privileged-rbac-assignments-weekly',
  'reports.storage-account-security-weekly',
  'reports.vms-without-backup-daily',
  'sweep.synthetic-transactions',
]);

const ENV_KEY = /\bAF_[A-Z0-9_]+/;
const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const shown = loaded.definitions
  .map(
    (d) =>
      d.def as { id: string; status?: string; title?: unknown; summary?: unknown; description?: unknown },
  )
  .filter((d) => d.status !== 'retired' && d.status !== 'draft')
  .map((d) => ({
    id: d.id,
    text: [d.title, d.summary, d.description].filter((v): v is string => typeof v === 'string').join('\n'),
  }));

describe('text shown in the portal names no configuration keys', () => {
  it('no definition outside the list names one', () => {
    const naming = shown.filter((d) => ENV_KEY.test(d.text)).map((d) => d.id);
    expect(naming.filter((id) => !STILL_NAMING_KEYS.has(id))).toEqual([]);
  });

  it('the list holds only definitions that still name one (take a definition off once it is reworded)', () => {
    const naming = new Set(shown.filter((d) => ENV_KEY.test(d.text)).map((d) => d.id));
    expect([...STILL_NAMING_KEYS].filter((id) => !naming.has(id))).toEqual([]);
  });

  it('billing.month-close says what to configure in words', () => {
    const def = shown.find((d) => d.id === 'billing.month-close');
    expect(def?.text).toMatch(/finance team/);
    expect(def?.text).not.toMatch(ENV_KEY);
  });
});
