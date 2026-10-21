/**
 * `adminforge publish [--env <name>] [--dry-run] [--allow-unreviewed]` — publishes new definition versions from
 * portal/content to the database (the SQLite file at DATABASE_PATH), the way the portal serves them. In Kubernetes it
 * runs in the pod: `kubectl exec deploy/adminforge -c api -- adminforge publish`.
 *
 * Steps, in order — any failure stops before the database is touched:
 *   1. the `adminforge validate` check (content/check.ts) and every playbook test (content/playbook-tests.ts);
 *   2. the review rule (content/review-state.ts): content committed and merged to origin's main as origin has it now
 *      (`git ls-remote`; unreachable = unreviewed) — or, in an image, built from such a commit against a freshly
 *      fetched main (BUILD.json) — otherwise refused, unless --allow-unreviewed (then recorded in the audit event;
 *      --dry-run only warns);
 *   3. the API's DbDefinitionStore writes new versions and sends the `definitions_changed` signal (the running API
 *      drops those cache entries) — idempotent by sha256 (an unchanged version is skipped) and all-or-nothing (changed
 *      content without a version bump, or an older version, is refused, and then nothing is written). Each row is
 *      stamped with the content schema version (@adminforge/schemas CONTENT_SCHEMA_VERSION), unchanged ones too;
 *      `--dry-run` lists the published versions stamped with an older one and whether they still pass;
 *   4. one `content.published` audit event in the database's hash chain (actor `cli`, the local user@host, versions,
 *      and the review provenance: the content commit, the main commit it was checked against and origin's URL without
 *      credentials), awaited — only when something new was created. In a pod the user is the image's (`adminforge`):
 *      the person who ran `kubectl exec` is named in the Kubernetes audit log, which `pods/exec` makes the boundary.
 *
 * Reads DATABASE_PATH (`--env` picks the env file, default dev) and brings that file's schema up to date first (as
 * the API does at start). Changes the definitions and audit tables of that database; nothing in the tenant. Exit
 * code 1 when nothing could be published or a version was refused.
 */
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { CONTENT_SCHEMA_VERSION } from '@adminforge/schemas';
import { databasePath } from '../shared/database-path';
import {
  createDatabase,
  DbDefinitionStore,
  migrateDatabase,
  SqliteAuditWriter,
  type PublishEntry,
  type PublishResult,
} from '../content/api-bridge';
import { checkContent } from '../content/check';
import type { ContentCliContext } from '../content/context';
import { runPlaybookTests } from '../content/playbook-tests';
import { reviewState } from '../content/review-state';
import { auditChainKeys } from './audit';

/**
 * `adminforge publish [--dry-run] [--allow-unreviewed]` — runs the same checks as `adminforge validate` and
 * `adminforge test`, publishes only reviewed content (committed, and the commit merged to origin/main) unless
 * `--allow-unreviewed` (recorded in the audit event), then writes new versions to the database (idempotent by sha256)
 * and sends the `definitions_changed` signal. Null when nothing was attempted.
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

  // Only reviewed content: committed, and the commit merged to origin's main (as origin has it now).
  const review = (ctx.review ?? ((dir: string) => reviewState(dir, undefined, { repoRoot: ctx.repoRoot })))(
    ctx.contentDir,
  );
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
  let assertCanRecord: (() => void) | undefined;
  if (ctx.openStore) target = await ctx.openStore();
  else {
    const keys = auditChainKeys(ctx.env);
    const database = createDatabase(databasePath(ctx.env), { name: 'cli', pollSignals: false });
    migrateDatabase(database);
    target = {
      store: new DbDefinitionStore(database.db, ctx.now, database.signals),
      close: () => database.close(),
    };
    const writer = new SqliteAuditWriter(database.db, ctx.now, undefined, undefined, keys);
    if (!audit) assertCanRecord = () => writer.assertCanAppend();
    audit ??= (input) => writer.append(input);
  }
  try {
    // Nothing is published that can't be recorded (a keyed audit chain needs AUDIT_CHAIN_KEY).
    if (!opts.dryRun) assertCanRecord?.();
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
          // Review provenance: what was published (commit), what it was checked against (mainCommit) and where.
          git: {
            commit: review.commit,
            dirty: review.dirty,
            onOriginMain: review.onOriginMain,
            mainCommit: review.mainCommit ?? null,
            remote: review.remote ?? null,
            ...(review.source === 'image' ? { source: 'image' } : {}),
          },
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
      `${result.refused ? '✗' : '✓'} ${verb}: ${result.created} new version(s), ${result.unchanged} unchanged, ${result.refused} refused${result.refreshed ? `, ${result.refreshed} restored to their authored key order` : ''}${opts.dryRun ? ' (dry run)' : ''}${result.notified ? '; the running portal was told (definitions_changed)' : ''}.`,
    );
    if (opts.dryRun && result.olderSchema) for (const l of olderSchemaLines(result.olderSchema)) ctx.out(l);
    return result;
  } finally {
    await target.close();
  }
}

/** Rows listed by name in a dry run; the rest are counted. */
const MAX_OLDER_LISTED = 50;

/**
 * Dry run: the published versions stamped with an older content schema version (D-07) — failing ones first, since the
 * API refuses them when it loads them — or that there are none.
 */
export function olderSchemaLines(rows: NonNullable<PublishResult['olderSchema']>): string[] {
  if (!rows.length)
    return [`✓ Every published version is on the current content schema (${CONTENT_SCHEMA_VERSION}).`];
  const failing = rows.filter((r) => r.problems.length);
  const ordered = [...failing, ...rows.filter((r) => !r.problems.length)];
  const lines = [
    `⚠ ${rows.length} published version(s) are from an older content schema (current: ${CONTENT_SCHEMA_VERSION}); ${
      failing.length
        ? `${failing.length} no longer pass(es) it and would be refused when loaded:`
        : 'all still pass it:'
    }`,
    ...ordered
      .slice(0, MAX_OLDER_LISTED)
      .map(
        (r) =>
          `  ${r.problems.length ? '✗' : '⚠'} ${r.kind} ${r.key} ${r.version}${r.status === 'retired' ? ' (retired)' : ''} (schema ${r.schemaVersion}) — ${r.problems.length ? r.problems.join('; ') : 'still valid'}`,
      ),
  ];
  if (ordered.length > MAX_OLDER_LISTED) lines.push(`  … and ${ordered.length - MAX_OLDER_LISTED} more`);
  return lines;
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
