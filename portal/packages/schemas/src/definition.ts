import { z } from 'zod';
import type { Kind } from './common';
import { Connection } from './connection';
import { Navigation } from './navigation';
import { Dashboard, Page, Report } from './page';
import { Playbook, Runbook } from './playbook';
import { Probe } from './probe';
import { Schedule } from './schedule';

/** One schema per content kind. */
export const DEFINITION_SCHEMAS = {
  page: Page,
  dashboard: Dashboard,
  report: Report,
  playbook: Playbook,
  runbook: Runbook,
  schedule: Schedule,
  probe: Probe,
  connection: Connection,
  navigation: Navigation,
} as const satisfies Record<Kind, z.ZodType>;

/** Any content definition, discriminated on `kind`. */
export const Definition = z.discriminatedUnion('kind', [Page, Dashboard, Report, Playbook, Runbook, Schedule, Probe, Connection, Navigation]);
export type Definition = z.infer<typeof Definition>;
export type DefinitionOf<K extends Kind> = Extract<Definition, { kind: K }>;

export function schemaForKind(kind: string): z.ZodType | undefined {
  return Object.hasOwn(DEFINITION_SCHEMAS, kind) ? DEFINITION_SCHEMAS[kind as Kind] : undefined;
}

/** Content that can contain write steps and therefore needs two-person publishing. */
export function isWriteCapable(def: Definition): boolean {
  if (def.kind === 'playbook' || def.kind === 'runbook') return def.mode === 'write';
  if (def.kind === 'schedule') return (def.job.kind === 'playbook' || def.job.kind === 'script') && def.job.mode === 'write';
  return false;
}
