import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { contentEnv } from '@adminforge/api/src/datasources/env';
import type { Config } from '@adminforge/api/src/config';
import { checkContent } from '@adminforge/cli/src/content/check';
import type { ContentCliContext } from '@adminforge/cli/src/content/context';
import { repoRoot } from '../../lib/repo';

// Settings whose names look like secrets (…_KEY, …TOKEN, …SECRET, …) never reach content expressions, so a reference
// to one is always empty — `adminforge validate` refuses it (AF_COST_TAG_KEY was silently ignored before it was
// renamed AF_COST_TAG_NAME). The billing and synthetic monitoring settings do reach content.
describe('settings content can read', () => {
  it('passes the billing and synthetic monitoring settings to content, never secret-looking ones', () => {
    const env = contentEnv({ NODE_ENV: 'test' } as Config, {
      AF_COST_TAG_NAME: 'Team',
      AF_COST_MANAGEMENT_GROUP_ID: 'mg-finance',
      AF_BILLING_ACCOUNT_ID: '1234',
      AF_FINANCE_RECIPIENTS: 'finance@example.com',
      AF_SYNTHETIC_MAILBOX: 'af-synthetic@example.com',
      AF_SYNTHETIC_SITE_ID: 'example.sharepoint.com,1,2',
      AF_SYNTHETIC_USER_ID: '00000000-0000-4000-8000-000000000001',
      AF_SYNTHETIC_TEAM_ID: '00000000-0000-4000-8000-000000000002',
      AF_COST_TAG_KEY: 'Team',
      AF_AUTOMATION_CLIENT_SECRET: 'x',
    });
    expect(Object.keys(env).sort()).toEqual([
      'AF_BILLING_ACCOUNT_ID',
      'AF_COST_MANAGEMENT_GROUP_ID',
      'AF_COST_TAG_NAME',
      'AF_FINANCE_RECIPIENTS',
      'AF_SYNTHETIC_MAILBOX',
      'AF_SYNTHETIC_SITE_ID',
      'AF_SYNTHETIC_TEAM_ID',
      'AF_SYNTHETIC_USER_ID',
    ]);
  });

  it('validate refuses content that names a setting content can never read', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'af-cli-hidden-'));
    try {
      const contentDir = path.join(root, 'content');
      mkdirSync(path.join(contentDir, 'probes'), { recursive: true });
      writeFileSync(
        path.join(contentDir, 'probes', 'p.probe.yaml'),
        [
          'kind: probe',
          'id: probes.p',
          'version: 1.0.0',
          'title: P',
          'owner: t',
          'check:',
          '  kind: http',
          '  url: "${ \'https://example.com/\' & env.RUNNER_SHARED_KEY }"',
        ].join('\n'),
      );
      const ctx: ContentCliContext = {
        env: {},
        out: () => undefined,
        repoRoot,
        contentDir,
        fixturesDir: root,
      };
      const report = await checkContent(ctx);
      expect(report.errors.join('\n')).toMatch(/env\.RUNNER_SHARED_KEY is never readable by content/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
