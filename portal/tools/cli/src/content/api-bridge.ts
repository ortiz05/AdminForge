/**
 * The API modules the CLI reuses, so `publish`, `fixtures record` and `audit` behave exactly like the portal: the
 * definition store, the database client, the outbound executor and automation identity, the datasource runner and
 * the audit writer. They come from `@adminforge/api/tooling`, the API's supported entry point for tools (a CLI
 * dependency; see portal/apps/api/src/tooling.ts) — never from `@adminforge/api/src/…` paths. CLI modules import
 * them from this file, so a change to what the CLI needs from the API is made here.
 */
export {
  createAutomationTokenProvider,
  createDatabase,
  createOutboundExecutor,
  DatasourceRunner,
  DbDefinitionStore,
  FsDefinitionSource,
  PgAuditWriter,
  registryFrom,
  type AuditInput,
  type AutomationTokenProvider,
  type Database,
  type PublishEntry,
  type PublishItem,
  type PublishResult,
  type UserScope,
} from '@adminforge/api/tooling';
