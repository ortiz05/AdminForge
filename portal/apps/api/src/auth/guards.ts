import type { PortalRole } from '@adminforge/schemas';
import type { FastifyRequest } from 'fastify';
import { AppError, unauthenticated } from '../errors';
import { assertCsrf } from '../security/csrf';
import type { SessionRecord } from './session-store';

export function requireSession(request: FastifyRequest): SessionRecord {
  if (!request.session) throw unauthenticated();
  return request.session;
}

/** Session + X-AdminForge-CSRF, for state-changing /auth routes. */
export function requireSessionWithCsrf(request: FastifyRequest): SessionRecord {
  const session = requireSession(request);
  assertCsrf(request);
  return session;
}

export const hasRole = (session: Pick<SessionRecord, 'roles'>, role: PortalRole) =>
  session.roles.includes(role);

/** The SG-AdminForge-<label>-<Role> groups grant each role (portal/tools/cli/src/provision/entra-desired.ts). */
const ROLE_GROUP: Record<PortalRole, string> = {
  'Portal.Reader': 'Reader',
  'Portal.Operator': 'Operator',
  'Playbook.Author': 'Playbook Author',
  'Playbook.Approver': 'Playbook Approver',
  'Portal.Admin': 'Admin',
};

export function requireRole(session: SessionRecord, role: PortalRole, action: string) {
  if (!hasRole(session, role))
    throw new AppError(403, 'forbidden', `${action} needs the ${role} role.`, {
      hint: `Ask a portal administrator to add you to the AdminForge ${ROLE_GROUP[role] ?? role} group (SG-AdminForge-…-${role}). It applies within 5 minutes.`,
    });
}
