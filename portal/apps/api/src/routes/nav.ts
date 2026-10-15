import type { NavItem, NavResponse, NavSection, PortalRole } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { hasRole, requireSession } from '../auth/guards';
import type { AppContext } from '../context';

const page = (key: string, label: string, icon?: string): NavItem => ({ key, label, href: `/p/${key}`, ...(icon ? { icon } : {}) });

type StaticSection = NavSection & { role?: PortalRole };

/**
 * Static navigation for Phase 1. Becomes content-driven (published definitions + roles) in Phase 3.
 * Icons are Phosphor icon component names (@phosphor-icons/react).
 */
const SECTIONS: StaticSection[] = [
  { key: 'overview', label: 'Overview', icon: 'House', items: [{ key: 'overview', label: 'Overview', href: '/', icon: 'House' }] },
  {
    key: 'identity',
    label: 'Identity',
    icon: 'IdentificationCard',
    items: [
      page('identity.users', 'Users', 'User'),
      page('identity.groups', 'Groups', 'UsersThree'),
      page('identity.roles', 'Roles & PIM', 'Crown'),
      page('identity.app-registrations', 'App registrations', 'AppWindow'),
      page('identity.enterprise-apps', 'Enterprise apps', 'SquaresFour'),
      page('identity.devices', 'Devices', 'Devices'),
      page('identity.conditional-access', 'Conditional Access', 'LockKey'),
    ],
  },
  {
    key: 'm365',
    label: 'Microsoft 365',
    icon: 'Buildings',
    items: [
      page('m365.exchange', 'Exchange', 'Envelope'),
      page('m365.distribution-lists', 'Distribution lists', 'AddressBook'),
      page('m365.teams', 'Teams', 'MicrosoftTeamsLogo'),
      page('m365.sharepoint', 'SharePoint', 'ShareNetwork'),
    ],
  },
  {
    key: 'endpoint',
    label: 'Endpoint',
    icon: 'Desktop',
    items: [
      page('endpoint.devices', 'Intune devices', 'Laptop'),
      page('endpoint.compliance', 'Compliance', 'SealCheck'),
      page('endpoint.configuration', 'Configuration', 'SlidersHorizontal'),
    ],
  },
  {
    key: 'security',
    label: 'Security',
    icon: 'ShieldCheck',
    items: [
      page('security.incidents', 'Defender incidents', 'Siren'),
      page('security.secure-score', 'Secure Score', 'Gauge'),
      page('security.risky-users', 'Risky users', 'UserFocus'),
    ],
  },
  {
    key: 'azure',
    label: 'Azure',
    icon: 'Cloud',
    items: [
      page('azure.resources', 'Resources', 'Cube'),
      page('azure.arc', 'Arc', 'HardDrives'),
      page('azure.monitoring', 'Monitoring', 'ChartLine'),
      page('azure.function-apps', 'Function Apps', 'Lightning'),
      page('azure.rbac', 'RBAC', 'Key'),
    ],
  },
  {
    key: 'automation',
    label: 'Automation',
    icon: 'Robot',
    items: [
      page('automation.playbooks', 'Playbooks', 'BookOpen'),
      page('automation.runbooks', 'Runbooks', 'Terminal'),
      page('automation.schedules', 'Schedules', 'CalendarBlank'),
      page('automation.probes', 'Probes', 'Heartbeat'),
      page('automation.runs', 'Runs', 'ClockCounterClockwise'),
    ],
  },
  { key: 'reports', label: 'Reports', icon: 'FileText', items: [page('reports.catalog', 'Reports', 'FileText')] },
  {
    key: 'admin',
    label: 'Admin',
    icon: 'GearSix',
    role: 'Portal.Admin',
    items: [page('admin.audit', 'Audit', 'Scroll'), page('admin.appearance', 'Appearance', 'Palette'), page('admin.settings', 'Settings', 'GearSix')],
  },
];

export function buildNav(roles: string[]): NavResponse {
  return {
    sections: SECTIONS.filter((s) => !s.role || hasRole({ roles }, s.role)).map(({ role: _role, ...section }) => structuredClone(section)),
  };
}

export function navRoutes(api: FastifyInstance, _ctx: AppContext) {
  api.get('/nav', async (request) => buildNav(requireSession(request).roles));
}
