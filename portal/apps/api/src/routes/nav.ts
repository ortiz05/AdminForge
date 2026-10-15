import type {
  Definition,
  NavItem,
  NavPlacement,
  NavResponse,
  NavSection,
  Navigation,
  PortalRole,
} from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { hasRole, requireSession } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import { missingLicences, requiresBadge, type TenantLicences } from '../capabilities/licences';
import type { AppContext } from '../context';
import type { DefinitionRecord } from '../definitions/types';

/** Kinds that can appear in navigation (via their `nav:` block) and where each opens. */
const NAV_KINDS = ['page', 'dashboard', 'report', 'playbook', 'runbook'] as const;
type NavKind = (typeof NAV_KINDS)[number];

/** In-app route of a definition (the web app's renderer routes). */
export function definitionHref(kind: string, key: string): string {
  if (kind === 'playbook') return `/playbooks/${key}`;
  if (kind === 'runbook') return `/runbooks/${key}`;
  return `/p/${key}`;
}

/** Coded routes that exist regardless of content (the Phase 1 overview at /). */
const BUILT_IN: Record<string, NavItem & { order: number }> = {
  overview: { key: 'overview', label: 'Overview', href: '/', icon: 'house', order: 0 },
};

const anyRole = (roles: string[], need: readonly PortalRole[] | undefined) =>
  !need?.length || need.some((r) => hasRole({ roles }, r));
const byOrder = <T extends { order?: number; label: string }>(a: T, b: T) =>
  (a.order ?? 1000) - (b.order ?? 1000) || a.label.localeCompare(b.label);

type Placed = { def: Definition & { nav?: NavPlacement }; kind: NavKind };

/**
 * Navigation from content (§6.5): section order/labels/icons from navigation.yaml, items from every page, dashboard,
 * report, playbook and runbook with a `nav:` block. Sections and items are filtered by portal roles; items whose
 * `requires.licences` the tenant lacks stay visible with a "Requires …" badge (R10). Empty sections are dropped.
 */
export function composeNav(input: {
  navigation: Navigation | undefined;
  definitions: DefinitionRecord[];
  roles: string[];
  licences: TenantLicences | null;
}): NavResponse {
  const { roles } = input;
  const placed: Placed[] = input.definitions
    .filter((r) => (NAV_KINDS as readonly string[]).includes(r.kind))
    .map((r) => ({ def: r.def as Placed['def'], kind: r.kind as NavKind }))
    .filter(
      ({ def }) =>
        def.nav &&
        !def.nav.hidden &&
        def.status !== 'draft' &&
        def.status !== 'retired' &&
        anyRole(roles, def.requires?.portalRoles),
    );

  const declared: Navigation['sections'] =
    input.navigation?.sections ??
    [...new Set(placed.map((p) => p.def.nav!.section))].map((key) => ({
      key,
      label: key.charAt(0).toUpperCase() + key.slice(1),
      icon: 'folder',
    }));

  const sections: Array<NavSection & { order?: number; index: number }> = [];
  declared.forEach((s, index) => {
    if (!anyRole(roles, s.roles)) return;
    const items: Array<NavItem & { order?: number }> = [];
    for (const it of s.items ?? [])
      if (anyRole(roles, it.roles))
        items.push({
          key: it.key,
          label: it.label,
          href: it.href,
          ...(it.icon ? { icon: it.icon } : {}),
          order: it.order,
        });
    for (const { def, kind } of placed) {
      if (def.nav!.section !== s.key) continue;
      const missing = missingLicences(input.licences, def.requires?.licences);
      items.push({
        key: def.id,
        label: def.nav!.label ?? def.title,
        href: definitionHref(kind, def.id),
        ...(def.nav!.icon ? { icon: def.nav!.icon } : {}),
        ...(missing?.length ? { badge: requiresBadge(missing) } : {}),
        order: def.nav!.order,
      });
    }
    const builtIn = BUILT_IN[s.key];
    if (builtIn && !items.some((i) => i.href === builtIn.href)) items.push(builtIn);
    if (!items.length) return;
    items.sort(byOrder);
    sections.push({
      key: s.key,
      label: s.label,
      icon: s.icon,
      items: items.map(({ order: _o, ...item }) => item),
      order: s.order,
      index,
    });
  });
  sections.sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.index - b.index);
  return { sections: sections.map(({ order: _o, index: _i, ...s }) => s) };
}

export async function buildNav(
  ctx: AppContext,
  session: SessionRecord,
  correlationId?: string,
): Promise<NavResponse> {
  const [navs, ...lists] = await Promise.all([
    ctx.definitions.list('navigation'),
    ...NAV_KINDS.map((k) => ctx.definitions.list(k)),
  ]);
  const definitions = lists.flat();
  const navigation = (navs.find((n) => n.key === 'portal.navigation') ?? navs[0])?.def as
    Navigation | undefined;
  // Only ask Graph for licences when something visible declares one.
  const needsLicences = definitions.some(
    (r) => (r.def as Placed['def']).nav && r.def.requires?.licences?.length,
  );
  const licences = needsLicences
    ? await ctx.licences.get({ kind: 'delegated', session, mode: 'read' }, { correlationId })
    : null;
  return composeNav({ navigation, definitions, roles: session.roles, licences });
}

export function navRoutes(api: FastifyInstance, ctx: AppContext) {
  api.get('/nav', async (request) => buildNav(ctx, requireSession(request), request.id));
}
