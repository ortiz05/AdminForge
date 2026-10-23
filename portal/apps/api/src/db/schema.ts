import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

/**
 * The SQLite schema (ADR-016). Column conventions — one place, so every store reads and writes the same shapes:
 * - ids are text UUIDs (`randomUUID`, like Postgres' gen_random_uuid before);
 * - instants are integer milliseconds since the epoch, read back as `Date` (`timestamp_ms`);
 * - structured values are JSON text (`mode: 'json'`): the authored key order is kept (definitions rely on it);
 * - lists (roles, areas, tags, audience) are JSON arrays, queried with `json_each`;
 * - booleans are 0/1.
 */
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const now = () => new Date();
const json = <T = unknown>(name: string) => text(name, { mode: 'json' }).$type<T>();
const list = (name: string) =>
  text(name, { mode: 'json' })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`);
const bool = (name: string) => integer(name, { mode: 'boolean' });
const uuid = (name: string) => text(name);
const uuidKey = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());

/**
 * Status values the database accepts (CHECK constraints). They mirror the code's own lists — RUN_STATUSES /
 * STEP_STATUSES (@adminforge/engine), SCHEDULE_RUN_STATUSES and TaskStatus (apps/api) — and
 * tests/unit/api/db-status-checks.test.ts keeps them equal: a new status needs a migration (`pnpm db:generate`).
 */
export const DB_RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'awaiting_arm',
  'awaiting_reauth',
  'succeeded',
  'failed',
  'cancelled',
  'compensated',
  'needs_review',
] as const;
export const DB_STEP_STATUSES = [
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'planned',
  'retried',
  'cancelled',
  'compensated',
  'needs_review',
] as const;
export const DB_SCHEDULE_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'timeout',
  'skipped',
] as const;
export const DB_APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;
export const DB_PROBE_STATUSES = ['ok', 'warn', 'crit', 'error'] as const;
export const DB_DEFINITION_STATUSES = ['draft', 'in_review', 'published', 'retired'] as const;
export const DB_RUN_JOB_STATES = ['queued', 'active'] as const;

/** `<column> in ('a', 'b', …)` for a CHECK constraint (the values are the fixed lists above, never input). */
const oneOf = (column: AnySQLiteColumn, values: readonly string[]) =>
  sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

/** Signed-in sessions. The cookie carries a random id; only sha256(id) is stored (§5.5). */
export const sessions = sqliteTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userOid: text('user_oid').notNull(),
    upn: text('upn').notNull(),
    displayName: text('display_name').notNull(),
    tenantId: text('tenant_id').notNull(),
    tenantName: text('tenant_name').notNull(),
    tenantDomain: text('tenant_domain').notNull(),
    roles: list('roles'),
    csrf: text('csrf').notNull(),
    readAccountId: text('read_account_id'),
    writeAccountId: text('write_account_id'),
    writeExpiresAt: ts('write_expires_at'),
    writeExtended: bool('write_extended').notNull().default(false),
    writeReason: text('write_reason'),
    createdAt: ts('created_at').notNull().$defaultFn(now),
    lastSeenAt: ts('last_seen_at').notNull().$defaultFn(now),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** When the roles were last confirmed with Entra (sign-in or the 5-minute re-check, by the API or the worker). */
    rolesCheckedAt: ts('roles_checked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userOid), index('sessions_expires_idx').on(t.expiresAt)],
);

/** Pending sign-in / arm round trips: single use, 10-minute TTL. */
export const preauth = sqliteTable(
  'preauth',
  {
    state: text('state').primaryKey(),
    /** read = sign-in; write = arm; schedule = a schedule's creator granting it their read access (ADR-014). */
    kind: text('kind', { enum: ['read', 'write', 'schedule'] }).notNull(),
    verifier: text('verifier').notNull(),
    nonce: text('nonce').notNull(),
    returnTo: text('return_to').notNull(),
    sessionIdHash: text('session_id_hash'),
    /** sha256 of the browser-binding cookie that started the round trip (login CSRF protection). */
    bindingHash: text('binding_hash'),
    /** sha256 of the client's address key (IPv4, or IPv6 /64) for a sign-in: its share of the pending sign-ins. */
    addressHash: text('address_hash'),
    details: json('details'),
    createdAt: ts('created_at').notNull().$defaultFn(now),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('preauth_expires_idx').on(t.expiresAt), index('preauth_address_idx').on(t.addressHash)],
);

/** MSAL token cache blobs, AES-256-GCM sealed with AAD = partition key (read:<sidHash> / write:<sidHash>). */
export const tokenCache = sqliteTable('token_cache', {
  partitionKey: text('partition_key').primaryKey(),
  sealed: text('sealed').notNull(),
  updatedAt: ts('updated_at').notNull().$defaultFn(now),
});

/** Append-only, hash-chained audit log (§5.9). AUTOINCREMENT: a seq is never handed out twice. */
export const auditEvents = sqliteTable(
  'audit_events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    ts: ts('ts').notNull(),
    actorOid: text('actor_oid'),
    actorUpn: text('actor_upn'),
    sessionHash: text('session_hash'),
    mode: text('mode'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: json('details'),
    result: text('result').notNull(),
    correlationId: text('correlation_id').notNull(),
    ip: text('ip'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    index('audit_actor_idx').on(t.actorOid),
    index('audit_action_idx').on(t.action),
    index('audit_ts_idx').on(t.ts),
    // "Reference" lookups from error pages and logs.
    index('audit_correlation_idx').on(t.correlationId),
  ],
);

/** Per-user preferences (theme, density, nav state, pins, recents). */
export const userPrefs = sqliteTable('user_prefs', {
  userOid: text('user_oid').primaryKey(),
  prefs: json('prefs')
    .notNull()
    .default(sql`'{}'`),
  updatedAt: ts('updated_at').notNull().$defaultFn(now),
});

/** Portal-wide settings (appearance, feature flags, write-mode policy). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json('value').notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().$defaultFn(now),
});

/** Content definitions (§7.9): every published version is kept; runs pin a version + sha256. */
export const definitions = sqliteTable(
  'definitions',
  {
    id: uuidKey(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    version: text('version').notNull(),
    /** draft | in_review | published | retired */
    status: text('status').notNull(),
    /** git (published from portal/content) | portal (authored in the editor, `local.` namespace) */
    source: text('source').notNull(),
    /** JSON text: the authored key order is kept (form field order, datasource order). */
    body: json('body').notNull(),
    sha256: text('sha256').notNull(),
    /**
     * The content schema version the row was published under (@adminforge/schemas CONTENT_SCHEMA_VERSION); rows from
     * before the column existed were published under version 1. Bodies are re-validated on load whatever it says.
     */
    schemaVersion: integer('schema_version').notNull().default(1),
    authorOid: text('author_oid'),
    approverOid: text('approver_oid'),
    createdAt: ts('created_at').notNull().$defaultFn(now),
    publishedAt: ts('published_at'),
  },
  (t) => [
    unique('definitions_kind_key_version').on(t.kind, t.key, t.version),
    index('definitions_lookup_idx').on(t.kind, t.key, t.status),
    check('definitions_status_check', oneOf(t.status, DB_DEFINITION_STATUSES)),
  ],
);

/** Saved list/report views (params, columns, filters), personal or shared. */
export const savedViews = sqliteTable(
  'saved_views',
  {
    id: uuidKey(),
    userOid: text('user_oid').notNull(),
    pageKey: text('page_key').notNull(),
    name: text('name').notNull(),
    state: json('state').notNull(),
    shared: bool('shared').notNull().default(false),
    createdAt: ts('created_at').notNull().$defaultFn(now),
    updatedAt: ts('updated_at').notNull().$defaultFn(now),
  },
  (t) => [index('saved_views_page_idx').on(t.pageKey, t.userOid)],
);

/** Playbook/runbook runs (§7.8). Interactive runs use delegated identities; scheduled runs use the automation identity. */
export const runs = sqliteTable(
  'runs',
  {
    id: uuidKey(),
    /** playbook | runbook */
    kind: text('kind').notNull(),
    definitionKey: text('definition_key').notNull(),
    definitionVersion: text('definition_version').notNull(),
    definitionSha256: text('definition_sha256').notNull(),
    /** queued | running | awaiting_approval | awaiting_input | awaiting_arm | awaiting_reauth | succeeded | failed | cancelled | compensated | needs_review */
    status: text('status').notNull(),
    dryRun: bool('dry_run').notNull().default(false),
    /** interactive | bulk | schedule | child */
    trigger: text('trigger').notNull().default('interactive'),
    /** delegated | automation */
    identity: text('identity').notNull().default('delegated'),
    /** With `automation`: the named app identity the schedule runs as (ADR-014); null = the automation identity. */
    identityName: text('identity_name'),
    initiatorOid: text('initiator_oid'),
    initiatorUpn: text('initiator_upn'),
    sessionHash: text('session_hash'),
    // A purged schedule or parent leaves the run's history in place (retention removes runs on its own clock).
    scheduleId: uuid('schedule_id').references((): AnySQLiteColumn => schedules.id, { onDelete: 'set null' }),
    parentRunId: uuid('parent_run_id').references((): AnySQLiteColumn => runs.id, { onDelete: 'set null' }),
    inputs: json('inputs')
      .notNull()
      .default(sql`'{}'`),
    outputs: json('outputs'),
    error: json('error'),
    correlationId: text('correlation_id').notNull(),
    createdAt: ts('created_at').notNull().$defaultFn(now),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    updatedAt: ts('updated_at').notNull().$defaultFn(now),
  },
  (t) => [
    index('runs_initiator_idx').on(t.initiatorOid, t.createdAt),
    index('runs_status_idx').on(t.status),
    index('runs_definition_idx').on(t.definitionKey),
    // Child runs of a parent (bulk items, nested playbooks) and retention by age.
    index('runs_parent_idx').on(t.parentRunId),
    index('runs_created_idx').on(t.createdAt),
    index('runs_schedule_idx').on(t.scheduleId),
    check('runs_status_check', oneOf(t.status, DB_RUN_STATUSES)),
  ],
);

/** One row per step attempt, in execution order. Requests and outputs are redacted/truncated. */
export const runSteps = sqliteTable(
  'run_steps',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    stepId: text('step_id').notNull(),
    /** Dotted path for nested steps, e.g. "loop[3].disable" */
    path: text('path').notNull(),
    type: text('type').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status').notNull(),
    actorOid: text('actor_oid'),
    mode: text('mode').notNull(),
    request: json('request'),
    plan: json('plan'),
    output: json('output'),
    error: json('error'),
    msRequestId: text('ms_request_id'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.seq] }),
    check('run_steps_status_check', oneOf(t.status, DB_STEP_STATUSES)),
  ],
);

/** Streamed step events (logs, progress, outputs) — also written by the PowerShell runner bridge. */
export const runStepEvents = sqliteTable(
  'run_step_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepSeq: integer('step_seq'),
    ts: ts('ts').notNull().$defaultFn(now),
    /** log | progress | output | status */
    type: text('type').notNull(),
    level: text('level'),
    data: json('data'),
  },
  (t) => [index('run_step_events_run_idx').on(t.runId, t.id)],
);

/** Approval gates on runs and on enabling write-capable schedules. */
export const approvals = sqliteTable(
  'approvals',
  {
    id: uuidKey(),
    /** run | schedule | definition */
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    stepId: text('step_id'),
    policy: json('policy').notNull(),
    decisions: json('decisions')
      .notNull()
      .default(sql`'[]'`),
    /** pending | approved | rejected | expired | cancelled */
    status: text('status').notNull().default('pending'),
    requestedBy: text('requested_by').notNull(),
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').notNull().$defaultFn(now),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    index('approvals_subject_idx').on(t.subjectType, t.subjectId),
    index('approvals_status_idx').on(t.status),
    check('approvals_status_check', oneOf(t.status, DB_APPROVAL_STATUSES)),
    // The append-only triggers count and compare array elements: anything but an array is refused outright.
    check('approvals_decisions_array', sql`json_type(${t.decisions}) = 'array'`),
  ],
);

/** Schedules executed by the scheduler in the API process (R6, ADR-011, ADR-016). */
export const schedules = sqliteTable(
  'schedules',
  {
    id: uuidKey(),
    key: text('key').notNull().unique(),
    /** content (portal/content/schedules) | portal (created in the UI / Forge assistant) */
    source: text('source').notNull(),
    definition: json('definition').notNull(),
    sha256: text('sha256').notNull(),
    enabled: bool('enabled').notNull().default(false),
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    /** Fingerprint of the playbook (and its child playbooks) the approval covered; a changed playbook voids it. */
    approvedTarget: text('approved_target'),
    nextRunAt: ts('next_run_at'),
    lastRunAt: ts('last_run_at'),
    lastStatus: text('last_status'),
    /**
     * The account an Operator chose for a content schedule (`automation` or `app:<name>`, identityKey), over what its
     * definition names; null = the definition's or the installation default. Kept when content is republished.
     */
    runAs: text('run_as'),
    runAsSetBy: text('run_as_set_by'),
    runAsSetAt: ts('run_as_set_at'),
    createdAt: ts('created_at').notNull().$defaultFn(now),
    updatedAt: ts('updated_at').notNull().$defaultFn(now),
  },
  (t) => [check('schedules_last_status_check', oneOf(t.lastStatus, DB_SCHEDULE_RUN_STATUSES))],
);

/**
 * Schedules that run with their creator's own delegated read access (ADR-014): who granted it and whether it still
 * works. The refresh token itself is sealed in `token_cache` under `schedule:<schedule_id>`; deleting the schedule
 * deletes this row, and housekeeping then drops the partition.
 */
export const scheduleGrants = sqliteTable(
  'schedule_grants',
  {
    scheduleId: uuid('schedule_id')
      .primaryKey()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    userOid: text('user_oid').notNull(),
    upn: text('upn').notNull(),
    homeAccountId: text('home_account_id').notNull(),
    /** active | needs_sign_in */
    status: text('status').notNull(),
    /** Why it needs sign-in (an error code), when it does. */
    reason: text('reason'),
    consentedAt: ts('consented_at').notNull(),
    checkedAt: ts('checked_at'),
  },
  (t) => [check('schedule_grants_status_check', oneOf(t.status, ['active', 'needs_sign_in']))],
);

/** Every execution of a schedule (cron or "run now"). */
export const scheduleRuns = sqliteTable(
  'schedule_runs',
  {
    id: uuidKey(),
    // NO ACTION: a schedule with history can't be deleted (retention removes portal schedules only once it has none).
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id),
    scheduleKey: text('schedule_key').notNull(),
    /** cron | manual | retry */
    trigger: text('trigger').notNull(),
    /** running | succeeded | failed | timeout | skipped */
    status: text('status').notNull(),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    result: json('result'),
    error: json('error'),
    artifactPath: text('artifact_path'),
    startedAt: ts('started_at').notNull().$defaultFn(now),
    endedAt: ts('ended_at'),
  },
  (t) => [
    index('schedule_runs_schedule_idx').on(t.scheduleId, t.startedAt),
    index('schedule_runs_run_idx').on(t.runId),
    check('schedule_runs_status_check', oneOf(t.status, DB_SCHEDULE_RUN_STATUSES)),
  ],
);

/** Synthetic probe results (time series for monitoring dashboards). */
export const probeResults = sqliteTable(
  'probe_results',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    probeKey: text('probe_key').notNull(),
    ts: ts('ts').notNull().$defaultFn(now),
    /** ok | warn | crit | error */
    status: text('status').notNull(),
    metric: real('metric'),
    durationMs: integer('duration_ms'),
    message: text('message'),
    details: json('details'),
    scheduleRunId: uuid('schedule_run_id').references((): AnySQLiteColumn => scheduleRuns.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('probe_results_probe_ts_idx').on(t.probeKey, t.ts),
    index('probe_results_schedule_run_idx').on(t.scheduleRunId),
    check('probe_results_status_check', oneOf(t.status, DB_PROBE_STATUSES)),
  ],
);

/**
 * News and changes: items collected from first-party Microsoft feeds (portal/content/feeds) by the scheduler's `news`
 * job. Plain text excerpts and citation links only; `audience` lists the portal roles a reader needs (all of them).
 */
export const newsItems = sqliteTable(
  'news_items',
  {
    id: uuidKey(),
    feedKey: text('feed_key').notNull(),
    /** The source's own id (MC123456, a tracking id, an RSS guid, Package@1.2.3). */
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    url: text('url').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    areas: list('areas'),
    tags: list('tags'),
    status: text('status'),
    audience: list('audience'),
    publishedAt: ts('published_at').notNull(),
    updatedAt: ts('updated_at'),
    /** coalesce(updated_at, published_at): feed order, day grouping and the `days` filter. */
    activityAt: ts('activity_at').notNull(),
    actionRequiredBy: ts('action_required_by'),
    firstSeenAt: ts('first_seen_at').notNull().$defaultFn(now),
    lastSeenAt: ts('last_seen_at').notNull().$defaultFn(now),
    /** When the content last changed (first insert: min(now, activity_at)); drives "unread". */
    changedAt: ts('changed_at').notNull().$defaultFn(now),
    contentHash: text('content_hash').notNull(),
    facts: json('facts')
      .notNull()
      .default(sql`'[]'`),
  },
  (t) => [
    unique('news_items_feed_external_uq').on(t.feedKey, t.externalId),
    index('news_items_activity_idx').on(t.activityAt, t.id),
    index('news_items_feed_idx').on(t.feedKey, t.activityAt),
    index('news_items_changed_idx').on(t.changedAt),
  ],
);

/** One row per feed: the last collection (status, sanitised error, conditional-GET validators, counts). */
export const newsFeedState = sqliteTable('news_feed_state', {
  feedKey: text('feed_key').primaryKey(),
  lastRunAt: ts('last_run_at'),
  lastSuccessAt: ts('last_success_at'),
  /** ok | error */
  status: text('status'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  items: integer('items').notNull().default(0),
  newItems: integer('new_items').notNull().default(0),
  updatedItems: integer('updated_items').notNull().default(0),
  durationMs: integer('duration_ms'),
  /** sha256 of the feed definition the last run used. */
  definitionSha: text('definition_sha'),
  /** Something worth knowing from the last successful run that isn't a failure. */
  note: text('note'),
});

/**
 * The run queue (replaces pg-boss): one job = "drive run X from its checkpoint". At most one queued and one active row
 * per run (unique run_id + state). The active row is leased to one process; an expired lease (the process died) is
 * queued again. `attempts` counts failed attempts for the retry backoff.
 */
export const runJobs = sqliteTable(
  'run_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    /** queued | active */
    state: text('state').notNull(),
    startAfter: ts('start_after').notNull(),
    attempts: integer('attempts').notNull().default(0),
    leaseHolder: text('lease_holder'),
    leaseUntil: ts('lease_until'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().$defaultFn(now),
  },
  (t) => [
    unique('run_jobs_run_state_uq').on(t.runId, t.state),
    index('run_jobs_due_idx').on(t.state, t.startAfter),
    check('run_jobs_state_check', oneOf(t.state, DB_RUN_JOB_STATES)),
  ],
);

/**
 * Named leases (replace Postgres advisory locks): the scheduler's leader lease and per-run locks. A lease belongs to
 * `holder` until `expires_at`; the holder renews it while it needs it.
 */
export const leases = sqliteTable('leases', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

/**
 * Cross-process notifications (replace LISTEN/NOTIFY): a process inserts a row, the others see it on their next poll
 * (`PRAGMA data_version` tells them something changed). Short-lived: housekeeping prunes rows after an hour.
 */
export const signals = sqliteTable(
  'signals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channel: text('channel').notNull(),
    payload: text('payload').notNull(),
    /** The publishing process (its own rows are delivered in-process at once and skipped by its poller). */
    origin: text('origin').notNull(),
    createdAt: ts('created_at').notNull().$defaultFn(now),
  },
  (t) => [index('signals_created_idx').on(t.createdAt)],
);
