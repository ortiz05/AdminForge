/** Services AdminForge talks to. Each maps to one Entra resource (audience). */
export type ServiceId =
  'graph' | 'arm' | 'logAnalytics' | 'exchange' | 'teams' | 'sharepointAdmin' | 'function' | 'runner';

/** Session mode: read-only, or armed write access. */
export type Mode = 'read' | 'write';

/** Where a piece of data came from; rendered in every widget's provenance footer. */
export interface Provenance {
  service: ServiceId;
  /** Path template without query values (no PII), e.g. "/users/{id}". */
  path: string;
  ms: number;
  requestId?: string;
  cachedAt?: string;
}

/** Supplies a bearer token for a service; never logged. */
export type TokenProvider = () => Promise<string>;

export type Sleep = (ms: number) => Promise<void>;
export const defaultSleep: Sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms));
