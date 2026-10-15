import { sql } from 'drizzle-orm';
import { bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
    roles: text('roles').array().notNull().default(sql`'{}'::text[]`),
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
  (t) => [index('audit_actor_idx').on(t.actorOid), index('audit_action_idx').on(t.action), index('audit_ts_idx').on(t.ts)],
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
