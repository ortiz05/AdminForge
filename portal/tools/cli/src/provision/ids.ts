/**
 * Deterministic ids and the GUID check the CLI shares: `isGuid` (env-file values, env/env-check.ts, the fixture
 * sanitizer's pattern via `GUID_PATTERN`) — @adminforge/schemas' one GUID check, re-exported — and RFC 4122 version-5
 * UUIDs in AdminForge's own namespace for app role ids and Azure role-assignment names, so every run (and every
 * tenant) computes the same id for the same object. Pure.
 */
import { createHash } from 'node:crypto';
import { isGuid } from '@adminforge/schemas';

export { GUID_PATTERN, isGuid } from '@adminforge/schemas';

/** Fixed namespace for AdminForge's deterministic ids (generated once; not tenant data). */
export const ADMINFORGE_NAMESPACE = '5b0e6c1e-8f3a-4d7b-9c2e-a41f0d6b7e93';

/** RFC 4122 version-5 (SHA-1, name-based) UUID. Same inputs → same id, in every run and every tenant. */
export function uuidV5(name: string, namespace: string = ADMINFORGE_NAMESPACE): string {
  if (!isGuid(namespace)) throw new Error('uuidV5 namespace must be a GUID');
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** App role id for a portal role in one environment. */
export const appRoleId = (label: string, roleValue: string) =>
  uuidV5(`adminforge:${label}:app-role:${roleValue}`);

/** Name (GUID) of an Azure role assignment; includes the principal so a re-created identity gets a new assignment. */
export const armRoleAssignmentName = (scope: string, roleDefinitionId: string, principalId: string) =>
  uuidV5(
    `adminforge:arm-role-assignment:${scope.toLowerCase()}:${roleDefinitionId.toLowerCase()}:${principalId.toLowerCase()}`,
  );
