/**
 * `@adminforge/api/tooling` — the supported entry point for code outside the API package that reuses API modules.
 * Two barrels, split by weight:
 *
 * - this one (`@adminforge/api/tooling`): configuration, the process context, database, definition store, outbound
 *   executor, automation identity, datasource runner, audit writer and email delivery. Used by the CLI
 *   (`portal/tools/cli/src/content/api-bridge.ts`: `publish`, `fixtures record`, `audit`), the live scripts
 *   (`tests/live/scripts/check-mail-sender.ts`, `run-schedule-once.ts`) and the scheduler service.
 * - `@adminforge/api/tooling/scheduler` (`tooling-scheduler.ts`): the runs and schedules modules, the scheduler and
 *   probes. Used by the scheduler service (`portal/apps/scheduler`) and, through its one-shot module,
 *   `run-schedule-once.ts`. Kept apart because loading it costs most of a second (job queue, report writers, news),
 *   which every CLI command would otherwise pay at start-up.
 *
 * Tools import from these two files, never from `@adminforge/api/src/…`: what they export is a contract the API keeps
 * stable for tools, and everything else is free to move. (Tests under `tests/` may still import `src/…` paths — they
 * test internals; that is what the package's `./src/*` export is for.) The API's own modules import each other
 * directly, never through a barrel.
 *
 * Adding an export: name the tool that needs it in the group comment, export only what a tool has to call (not a
 * whole module for convenience), and check the tool still type-checks (`pnpm -r run typecheck`). Importing a barrel
 * has no side effects: nothing reads the environment or opens a connection until a tool calls `loadConfig()`,
 * `createContext()` or `createDatabase()`.
 */

// The FastifyRequest augmentation (`request.session`): API modules reached from here use it, so a tool that
// type-checks them needs it in its program too.
import type {} from './auth/session-plugin';

// Configuration and the process context (scheduler, live scripts).
export { loadConfig, type Config } from './config';
export { createContext, type AppContext, type AppDeps } from './context';
/** Log fields with bound database values stripped (the scheduler's JSON log lines). */
export { safeLogFields } from './logging';

// Database (CLI: publish, audit; the scheduler's startup role check).
export { assertDatabaseRole, createDatabase, type Database } from './db/client';

// Definitions: the Postgres store `publish` writes and the file source it reads (CLI).
export {
  DbDefinitionStore,
  FsDefinitionSource,
  registryFrom,
  type PublishEntry,
  type PublishItem,
  type PublishResult,
} from './definitions/index';

// Outbound calls as the automation identity, and the datasource runner (CLI: fixtures record).
export { createOutboundExecutor } from './execution/outbound';
export { createAutomationTokenProvider, type AutomationTokenProvider } from './auth/automation';
export { DatasourceRunner, type UserScope } from './datasources/executor';

// Audit writer (CLI: publish and audit).
export { PgAuditWriter, type AuditInput } from './audit/writer';

// Email and Teams delivery: the configuration keys delivery reads and the notifier (scheduler one-shots,
// run-schedule-once, check-mail-sender).
export { RECIPIENT_KEY, SENDER_KEY, WEBHOOK_KEY, sendEmail, type DeliveryDeps } from './delivery/notifier';
