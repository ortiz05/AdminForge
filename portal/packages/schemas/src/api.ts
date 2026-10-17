import { z } from 'zod';

import { KQL_SOURCES, PORTAL_ROLES } from './constants';

export { PORTAL_ROLES };
export const PortalRole = z.enum(PORTAL_ROLES);
export type PortalRole = z.infer<typeof PortalRole>;

export const ThemePref = z.enum(['steel', 'daylight', 'contrast', 'system']);
export const DensityPref = z.enum(['comfortable', 'compact']);

export const UserPrefs = z.object({
  theme: ThemePref.optional(),
  density: DensityPref.optional(),
  navCollapsed: z.boolean().optional(),
  /**
   * Keys of the navigation sections the person opened (Identity, Azure, …). Sections start collapsed, so a section
   * added later starts collapsed too; a collapsed section still shows the page you're on.
   */
  navOpenSections: z.array(z.string().max(64)).max(30).optional(),
  /** Superseded by `navOpenSections` (2026-10-16): the sections closed when everything started open. No longer read. */
  navSections: z.array(z.string().max(64)).max(30).optional(),
  pinned: z.array(z.string()).max(50).optional(),
  recents: z.array(z.string()).max(50).optional(),
  /** When the person last marked News and changes as read (ISO date-time). */
  newsSeenAt: z.iso.datetime({ offset: true }).optional(),
});
export type UserPrefs = z.infer<typeof UserPrefs>;

/** GET /api/me */
export const MeResponse = z.object({
  user: z.object({ oid: z.string(), upn: z.string(), name: z.string(), tenantId: z.string() }),
  tenant: z.object({ name: z.string(), domain: z.string() }),
  roles: z.array(z.string()),
  /** read = Read-app tokens only; armed = Write-app tokens held until armedUntil. */
  mode: z.enum(['read', 'armed']),
  armedUntil: z.string().nullable(),
  /** Whether this user may arm (Portal.Operator); Entra still enforces Write-app assignment. */
  canArm: z.boolean(),
  /** Extension already used for this armed session. */
  armExtended: z.boolean(),
  /** Longest write session the server allows (WRITE_SESSION_MAX_MINUTES). */
  armMaxMinutes: z.number().int().positive(),
  csrf: z.string(),
  prefs: UserPrefs,
  /** Organisation defaults from Admin → Appearance, used where the person has no preference of their own. */
  defaults: z
    .object({ theme: ThemePref.optional(), density: z.enum(['comfortable', 'compact']).optional() })
    .optional(),
  authMode: z.enum(['entra', 'mock']),
  dataMode: z.enum(['live', 'fixtures']),
  /** Query Studio sources this installation offers (AF_QUERY_SOURCES). Absent (an older API) = all of them. */
  querySources: z.array(z.enum(KQL_SOURCES)).optional(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** Uniform JSON error body for every /api and /auth error. */
export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
    /** Present on 401: where to send the browser to sign in — only the app's own /auth/login. */
    login: z
      .string()
      .regex(/^\/auth\/login(?:\?|$)/)
      .optional(),
    /** Present when a claims challenge or step-up is required. */
    reauth: z.object({ url: z.string() }).optional(),
    /** Upstream identifier an administrator can look up (e.g. AADSTS50105, a Graph error code). */
    detail: z.string().optional(),
    correlationId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** GET /api/nav */
export const NavItem = z.object({
  key: z.string(),
  label: z.string(),
  href: z.string(),
  icon: z.string().optional(),
  badge: z.string().optional(),
});
export const NavSection = z.object({
  key: z.string(),
  label: z.string(),
  icon: z.string(),
  items: z.array(NavItem),
});
export const NavResponse = z.object({ sections: z.array(NavSection) });
export type NavItem = z.infer<typeof NavItem>;
export type NavSection = z.infer<typeof NavSection>;
export type NavResponse = z.infer<typeof NavResponse>;

/** POST /auth/arm (body) — reason and duration are audited. */
export const ArmRequest = z.object({
  minutes: z.number().int().min(5).max(480),
  reason: z.string().trim().min(5).max(500),
});
export type ArmRequest = z.infer<typeof ArmRequest>;
