/**
 * `adminforge publish [--env <name>] [--dry-run] [--allow-unreviewed]` — publishes new definition versions from
 * portal/content to Postgres, the way the portal serves them.
 *
 * Steps, in order — any failure stops before the database is touched:
 *   1. the `adminforge validate` check (content/check.ts) and every playbook test (content/playbook-tests.ts);
 *   2. the review rule (content/review-state.ts): content committed and merged to origin/main as last fetched —
 *      otherwise refused, unless --allow-unreviewed (then recorded in the audit event; --dry-run only warns);
 *   3. the API's DbDefinitionStore writes new versions and sends NOTIFY definitions_changed — idempotent by sha256
 *      (an unchanged version is skipped) and all-or-nothing (changed content without a version bump, or an older
 *      version, is refused, and then nothing is written);
 *   4. one `content.published` audit event in the database's hash chain (actor `cli`, the local user@host, versions,
 *      git state), awaited — only when something new was created.
 *
 * Reads DATABASE_URL (`--env` picks the env file, default dev; use the dev database, never the services' host
 * overlay). Changes the definitions and audit tables of that database; nothing in the tenant. Exit code 1 when
 * nothing could be published or a version was refused.
 */
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { ConfigError } from '../shared/errors';
import {
  createDatabase,
  DbDefinitionStore,
  PgAuditWriter,
  type PublishEntry,
  type PublishResult,
} from '../content/api-bridge';
import { checkContent } from '../content/check';
import type { ContentCliContext } from '../content/context';
import { runPlaybookTests } from '../content/playbook-tests';
import { reviewState } from '../content/review-state';

/**
 * `adminforge publish [--dry-run] [--allow-unreviewed]` — runs the same checks as `adminforge validate` and
 * `adminforge test`, publishes only reviewed content (committed, and the commit merged to origin/main) unless
 * `--allow-unreviewed` (recorded in the audit event), then writes new versions to Postgres (idempotent by sha256) and
 * sends NOTIFY definitions_changed. Null when nothing was attempted.
 */
export async function publishContent(
  ctx: ContentCliContext,
  opts: { dryRun?: boolean; allowUnreviewed?: boolean } = {},
): Promise<PublishResult | null> {
  // The same gate as `adminforge validate` and `adminforge test`: nothing reaches the database that would fail them.
  const report = await checkContent(ctx);
  if (report.errors.length) {
    for (const e of report.errors) ctx.out(`✗ ${e}`);
    ctx.out('✗ Nothing published: fix the content first (adminforge validate).');
    return null;
  }
  const tests = await runPlaybookTests(ctx, { loaded: report.loaded });
  if (!tests.ran || tests.failed) {
    for (const l of tests.lines) if (l.startsWith('✗')) ctx.out(l);
    ctx.out(
      tests.ran
        ? `✗ Nothing published: ${tests.failed} playbook test(s) failed (adminforge test).`
        : '✗ Nothing published: the playbook engine is not available, so the playbook tests could not run (adminforge test).',
    );
    return null;
  }
  ctx.out(
    `✓ ${report.definitions} definitions valid (schema, references, expressions, lint, env keys); ${tests.passed} playbook test(s) passed.`,
  );

  // Only reviewed content: committed, and the commit merged to origin/main (as last fetched).
  const review = (ctx.review ?? reviewState)(ctx.contentDir);
  const unreviewed = review.problems.length > 0;
  if (unreviewed) {
    const mark = opts.allowUnreviewed ? '⚠' : '✗';
    for (const p of review.problems) ctx.out(`${mark} ${p.message}`);
    if (opts.allowUnreviewed)
      ctx.out('⚠ Publishing unreviewed content (--allow-unreviewed): the audit event records it.');
    else if (opts.dryRun)
      ctx.out(
        '⚠ A real publish would be refused: commit the content and merge it to origin/main, or pass --allow-unreviewed.',
      );
    else {
      ctx.out(
        '✗ Nothing published: publish reviewed content only — commit it and merge it to origin/main (then git fetch), or pass --allow-unreviewed (recorded in the audit log).',
      );
      return null;
    }
  }

  const entries: PublishEntry[] = report.loaded.map((d) => ({
    def: d.def,
    sha256: d.sha256,
    source: 'git',
    file: d.file,
  }));
  let target: { store: Pick<DbDefinitionStore, 'publish'>; close: () => Promise<void> };
  let audit = ctx.audit;
  if (ctx.openStore) target = await ctx.openStore();
  else {
    const url = ctx.env.DATABASE_URL;
    if (!url) throw new ConfigError('DATABASE_URL is not set in the env file.');
    const database = createDatabase(url, { max: 2, name: 'cli' });
    target = { store: new DbDefinitionStore(database.db), close: () => database.close() };
    const writer = new PgAuditWriter(database.db, ctx.now);
    audit ??= (input) => writer.append(input);
  }
  try {
    const result = await target.store.publish(entries, { dryRun: opts.dryRun });
    // Content changes what the portal can do: who published which versions goes into the audit chain.
    const created = result.items.filter((i) => i.action === 'create');
    if (!opts.dryRun && result.applied && created.length && audit)
      await audit({
        actorOid: 'cli',
        actorUpn: publisher(),
        mode: 'write',
        action: 'content.published',
        correlationId: randomUUID(),
        targetType: 'definitions',
        targetId: `${created.length} version(s)`,
        result: 'success',
        details: {
          versions: created.map(
            (i) => `${i.kind}:${i.key}@${i.version}${i.status === 'retired' ? ' (retired)' : ''}`,
          ),
          refused: result.refused,
          git: { commit: review.commit, dirty: review.dirty, onOriginMain: review.onOriginMain },
          unreviewed,
          ...(unreviewed ? { reasons: [...new Set(review.problems.map((p) => p.reason))] } : {}),
        },
      });
    for (const i of result.items) {
      if (i.action === 'unchanged') continue;
      const mark = i.action === 'create' ? (i.status === 'retired' ? '− retire' : '+ publish') : '✗ refused';
      ctx.out(
        `${mark}  ${i.kind} ${i.key} ${i.version}${i.reason ? ` — ${i.reason}` : ''}${i.file ? `  (${i.file})` : ''}`,
      );
    }
    const verb = opts.dryRun ? 'would publish' : result.applied ? 'published' : 'nothing published';
    ctx.out(
      `${result.refused ? '✗' : '✓'} ${verb}: ${result.created} new version(s), ${result.unchanged} unchanged, ${result.refused} refused${result.refreshed ? `, ${result.refreshed} restored to their authored key order` : ''}${opts.dryRun ? ' (dry run)' : ''}${result.notified ? '; NOTIFY definitions_changed sent' : ''}.`,
    );
    return result;
  } finally {
    await target.close();
  }
}

/** Who ran the CLI (local account and host), for the audit trail. */
function publisher(): string {
  try {
    return `${userInfo().username}@${hostname()}`;
  } catch {
    // Deliberately tolerated: some containers have no passwd entry; the event still records that the CLI published.
    return 'unknown@cli';
  }
}
