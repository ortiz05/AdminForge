import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Signed-in sessions. The cookie carries a random id; only sha256(id) is stored (§5.5). */
export const sessions = pgTable(
  'sessions',
  {
    idHash: text('id_hash').primaryKey(),
    userOid: text('user_oid').notNull(),
    upn: text('upn').notNull(),
    displayName: text('display_name').notNull(),
    tenantId: text('tenant_id').notNull(),
    tenantName: text('tenant_name').notNull(),
    tenantDomain: text('tenant_domain').notNull(),
    roles: text('roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    csrf: text('csrf').notNull(),
    readAccountId: text('read_account_id'),
    writeAccountId: text('write_account_id'),
    writeExpiresAt: ts('write_expires_at'),
    writeExtended: boolean('write_extended').notNull().default(false),
    writeReason: text('write_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** When the roles were last confirmed with Entra (sign-in or the 5-minute re-check, by the API or the worker). */
    rolesCheckedAt: ts('roles_checked_at'),
  },
  (t) => [index('sessions_user_idx').on(t.userOid), index('sessions_expires_idx').on(t.expiresAt)],
);

/** Pending sign-in / arm round trips: single use, 10-minute TTL. */
export const preauth = pgTable(
  'preauth',
  {
    state: text('state').primaryKey(),
    kind: text('kind', { enum: ['read', 'write'] }).notNull(),
    verifier: text('verifier').notNull(),
    nonce: text('nonce').notNull(),
    returnTo: text('return_to').notNull(),
    sessionIdHash: text('session_id_hash'),
    /** sha256 of the browser-binding cookie that started the round trip (login CSRF protection). */
    bindingHash: text('binding_hash'),
    details: jsonb('details'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('preauth_expires_idx').on(t.expiresAt)],
);

/** MSAL token cache blobs, AES-256-GCM sealed with AAD = partition key (read:<sidHash> / write:<sidHash>). */
export const tokenCache = pgTable('token_cache', {
  partitionKey: text('partition_key').primaryKey(),
  sealed: text('sealed').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Append-only, hash-chained audit log (§5.9). */
export const auditEvents = pgTable(
  'audit_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    ts: ts('ts').notNull(),
    actorOid: text('actor_oid'),
    actorUpn: text('actor_upn'),
    sessionHash: text('session_hash'),
    mode: text('mode'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details'),
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
export const userPrefs = pgTable('user_prefs', {
  userOid: text('user_oid').primaryKey(),
  prefs: jsonb('prefs').notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Portal-wide settings (appearance, feature flags, write-mode policy). */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  version: integer('version').notNull().default(1),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Content definitions (§7.9): every published version is kept; runs pin a version + sha256. */
export const definitions = pgTable(
  'definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    version: text('version').notNull(),
    /** draft | in_review | published | retired */
    status: text('status').notNull(),
    /** git (published from portal/content) | portal (authored in the editor, `local.` namespace) */
    source: text('source').notNull(),
    body: jsonb('body').notNull(),
    sha256: text('sha256').notNull(),
    authorOid: text('author_oid'),
    approverOid: text('approver_oid'),
    createdAt: ts('created_at').notNull().defaultNow(),
    publishedAt: ts('published_at'),
  },
  (t) => [
    unique('definitions_kind_key_version').on(t.kind, t.key, t.version),
    index('definitions_lookup_idx').on(t.kind, t.key, t.status),
  ],
);

/** Saved list/report views (params, columns, filters), personal or shared. */
export const savedViews = pgTable(
  'saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userOid: text('user_oid').notNull(),
    pageKey: text('page_key').notNull(),
    name: text('name').notNull(),
    state: jsonb('state').notNull(),
    shared: boolean('shared').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('saved_views_page_idx').on(t.pageKey, t.userOid)],
);

/** Playbook/runbook runs (§7.8). Interactive runs use delegated identities; scheduled runs use the automation identity. */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** playbook | runbook */
    kind: text('kind').notNull(),
    definitionKey: text('definition_key').notNull(),
    definitionVersion: text('definition_version').notNull(),
    definitionSha256: text('definition_sha256').notNull(),
    /** queued | running | awaiting_approval | awaiting_input | awaiting_arm | awaiting_reauth | succeeded | failed | cancelled | compensated | needs_review */
    status: text('status').notNull(),
    dryRun: boolean('dry_run').notNull().default(false),
    /** interactive | bulk | schedule | child */
    trigger: text('trigger').notNull().default('interactive'),
    /** delegated | automation */
    identity: text('identity').notNull().default('delegated'),
    initiatorOid: text('initiator_oid'),
    initiatorUpn: text('initiator_upn'),
    sessionHash: text('session_hash'),
    scheduleId: uuid('schedule_id'),
    parentRunId: uuid('parent_run_id'),
    inputs: jsonb('inputs').notNull().default({}),
    outputs: jsonb('outputs'),
    error: jsonb('error'),
    correlationId: text('correlation_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('runs_initiator_idx').on(t.initiatorOid, t.createdAt),
    index('runs_status_idx').on(t.status),
    index('runs_definition_idx').on(t.definitionKey),
    // Child runs of a parent (bulk items, nested playbooks) and retention by age.
    index('runs_parent_idx').on(t.parentRunId),
    index('runs_created_idx').on(t.createdAt),
  ],
);

/** One row per step attempt, in execution order. Requests and outputs are redacted/truncated. */
export const runSteps = pgTable(
  'run_steps',
  {
    runId: uuid('run_id').notNull(),
    seq: integer('seq').notNull(),
    stepId: text('step_id').notNull(),
    /** Dotted path for nested steps, e.g. "loop[3].disable" */
    path: text('path').notNull(),
    type: text('type').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: text('status').notNull(),
    actorOid: text('actor_oid'),
    mode: text('mode').notNull(),
    request: jsonb('request'),
    plan: jsonb('plan'),
    output: jsonb('output'),
    error: jsonb('error'),
    msRequestId: text('ms_request_id'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/** Streamed step events (logs, progress, outputs) — also written by the PowerShell runner bridge. */
export const runStepEvents = pgTable(
  'run_step_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id').notNull(),
    stepSeq: integer('step_seq'),
    ts: ts('ts').notNull().defaultNow(),
    /** log | progress | output | status */
    type: text('type').notNull(),
    level: text('level'),
    data: jsonb('data'),
  },
  (t) => [index('run_step_events_run_idx').on(t.runId, t.id)],
);

/** Approval gates on runs and on enabling write-capable schedules. */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** run | schedule | definition */
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    stepId: text('step_id'),
    policy: jsonb('policy').notNull(),
    decisions: jsonb('decisions').notNull().default([]),
    /** pending | approved | rejected | expired */
    status: text('status').notNull().default('pending'),
    requestedBy: text('requested_by').notNull(),
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    decidedAt: ts('decided_at'),
  },
  (t) => [
    index('approvals_subject_idx').on(t.subjectType, t.subjectId),
    index('approvals_status_idx').on(t.status),
  ],
);

/** Schedules executed on this host by the scheduler (R6, ADR-011). */
export const schedules = pgTable('schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  /** content (portal/content/schedules) | portal (created in the UI / Forge assistant) */
  source: text('source').notNull(),
  definition: jsonb('definition').notNull(),
  sha256: text('sha256').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  createdBy: text('created_by'),
  approvedBy: text('approved_by'),
  /** Fingerprint of the playbook (and its child playbooks) the approval covered; a changed playbook voids it. */
  approvedTarget: text('approved_target'),
  nextRunAt: ts('next_run_at'),
  lastRunAt: ts('last_run_at'),
  lastStatus: text('last_status'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Every execution of a schedule (cron or "run now"). */
export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id').notNull(),
    scheduleKey: text('schedule_key').notNull(),
    /** cron | manual | retry */
    trigger: text('trigger').notNull(),
    /** running | succeeded | failed | timeout | skipped */
    status: text('status').notNull(),
    runId: uuid('run_id'),
    result: jsonb('result'),
    error: jsonb('error'),
    artifactPath: text('artifact_path'),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('schedule_runs_schedule_idx').on(t.scheduleId, t.startedAt)],
);

/** Synthetic probe results (time series for monitoring dashboards). */
export const probeResults = pgTable(
  'probe_results',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    probeKey: text('probe_key').notNull(),
    ts: ts('ts').notNull().defaultNow(),
    /** ok | warn | crit | error */
    status: text('status').notNull(),
    metric: doublePrecision('metric'),
    durationMs: integer('duration_ms'),
    message: text('message'),
    details: jsonb('details'),
    scheduleRunId: uuid('schedule_run_id'),
  },
  (t) => [index('probe_results_probe_ts_idx').on(t.probeKey, t.ts)],
);

/**
 * News and changes: items collected from first-party Microsoft feeds (portal/content/feeds) by the scheduler's `news`
 * job. Plain text excerpts and citation links only; `audience` lists the portal roles a reader needs (all of them).
 */
export const newsItems = pgTable(
  'news_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    feedKey: text('feed_key').notNull(),
    /** The source's own id (MC123456, a tracking id, an RSS guid, Package@1.2.3). */
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    url: text('url').notNull(),
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    areas: text('areas')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status'),
    audience: text('audience')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    publishedAt: ts('published_at').notNull(),
    updatedAt: ts('updated_at'),
    /** coalesce(updated_at, published_at): feed order, day grouping and the `days` filter. */
    activityAt: ts('activity_at').notNull(),
    actionRequiredBy: ts('action_required_by'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    /** When the content last changed (first insert: least(now, activity_at)); drives "unread". */
    changedAt: ts('changed_at').notNull().defaultNow(),
    contentHash: text('content_hash').notNull(),
    facts: jsonb('facts')
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (t) => [
    unique('news_items_feed_external_uq').on(t.feedKey, t.externalId),
    index('news_items_activity_idx').on(t.activityAt.desc(), t.id.desc()),
    index('news_items_feed_idx').on(t.feedKey, t.activityAt),
    index('news_items_changed_idx').on(t.changedAt),
    index('news_items_areas_idx').using('gin', t.areas),
  ],
);

/** One row per feed: the last collection (status, sanitised error, conditional-GET validators, counts). */
export const newsFeedState = pgTable('news_feed_state', {
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
