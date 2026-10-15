/**
 * The CLI reuses the BFF's definition store and outbound/datasource code so `publish` and `fixtures record` behave
 * exactly like the portal. @adminforge/api is not a CLI dependency (yet), so these are path imports; their own
 * imports (pg, drizzle, msal, …) resolve from the api package. One file to change when the dependency is added.
 */
export { createDatabase, type Database } from '@adminforge/api/src/db/client';
export {
  DbDefinitionStore,
  FsDefinitionSource,
  registryFrom,
  type PublishEntry,
  type PublishItem,
  type PublishResult,
} from '@adminforge/api/src/definitions/index';
export { createOutboundExecutor } from '@adminforge/api/src/execution/outbound';
export {
  createAutomationTokenProvider,
  type AutomationTokenProvider,
} from '@adminforge/api/src/auth/automation';
export { DatasourceRunner, type UserScope } from '@adminforge/api/src/datasources/executor';
