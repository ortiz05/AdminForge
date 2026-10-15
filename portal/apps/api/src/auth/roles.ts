import { PORTAL_ROLES, type PortalRole } from '@adminforge/schemas';
import type { IdClaims } from './types';

/** The AdminForge roles in an ID token's `roles` claim (app roles assigned through the SG-AdminForge-* groups). */
export const portalRoles = (claims: Pick<IdClaims, 'roles'>): PortalRole[] =>
  (claims.roles ?? []).filter((r): r is PortalRole => (PORTAL_ROLES as readonly string[]).includes(r));
