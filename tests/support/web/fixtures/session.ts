/**
 * The signed-in session every mock-mode suite starts from: `FIXED_NOW` (the pinned clock), `me()` / `armedMe()`
 * (GET /api/me as a read-mode or armed engineer, overridable) and `NAV` (GET /api/nav). Synthetic only. Used by the
 * other fixtures, tests/e2e (specs and mock-api.ts), the component tests and unit/web.
 */
import type { MeResponse, NavResponse } from '@adminforge/schemas';

/** Fixed clock for screenshots: relative times and the arm countdown never drift. */
export const FIXED_NOW = Date.parse('2026-10-15T14:00:00.000Z');

/** Synthetic identifiers only (Example Org / example.com). */
export const TENANT_ID = '6c1d4e2a-8b3f-4a57-9d0e-2f7a1b5c9e34';

export function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user: {
      oid: '0b9e7c2d-41a5-4f68-b3d1-7e2c5a9f0d16',
      upn: 'mock.engineer@example.com',
      name: 'Mock Engineer',
      tenantId: TENANT_ID,
    },
    tenant: { name: 'Example Org', domain: 'example.com' },
    roles: ['Portal.Reader', 'Portal.Operator'],
    mode: 'read',
    armedUntil: null,
    canArm: true,
    armExtended: false,
    armMaxMinutes: 60,
    csrf: 'e2e-csrf-token',
    prefs: {},
    authMode: 'mock',
    dataMode: 'fixtures',
    ...overrides,
  };
}

/** 47 minutes 12 seconds of write access left at FIXED_NOW. */
export function armedMe(): MeResponse {
  return me({ mode: 'armed', armedUntil: new Date(FIXED_NOW + (47 * 60 + 12) * 1000).toISOString() });
}

const item = (key: string, label: string, href: string, icon?: string) => ({
  key,
  label,
  href,
  ...(icon ? { icon } : {}),
});

export const NAV: NavResponse = {
  sections: [
    {
      key: 'overview',
      label: 'Overview',
      icon: 'house',
      items: [item('overview', 'Tenant overview', '/', 'gauge')],
    },
    {
      key: 'identity',
      label: 'Identity',
      icon: 'identification-card',
      items: [
        item('users', 'Users', '/identity/users', 'users'),
        item('groups', 'Groups', '/identity/groups', 'users-three'),
        item('roles', 'Roles & PIM', '/identity/roles', 'shield-star'),
        item('app-registrations', 'App registrations', '/identity/app-registrations', 'app-window'),
        item('conditional-access', 'Conditional Access', '/identity/conditional-access', 'lock-key'),
        item('sign-ins', 'Sign-in logs', '/identity/sign-ins', 'fingerprint'),
      ],
    },
    {
      key: 'm365',
      label: 'Microsoft 365',
      icon: 'squares-four',
      items: [
        item('licences', 'Licences', '/m365/licences', 'receipt'),
        item('service-health', 'Service health', '/m365/service-health', 'heartbeat'),
        item('mailboxes', 'Mailboxes', '/m365/mailboxes', 'envelope'),
        item('teams', 'Teams', '/m365/teams', 'chats-circle'),
      ],
    },
    {
      key: 'endpoint',
      label: 'Endpoint',
      icon: 'devices',
      items: [
        item('devices', 'Devices', '/endpoint/devices', 'desktop'),
        item('compliance', 'Compliance', '/endpoint/compliance', 'shield-check'),
      ],
    },
    {
      key: 'azure',
      label: 'Azure',
      icon: 'cloud',
      items: [
        item('resources', 'Resources', '/azure/resources', 'cube'),
        item('function-apps', 'Function Apps', '/azure/function-apps', 'function'),
      ],
    },
    {
      key: 'automation',
      label: 'Automation',
      icon: 'lightning',
      items: [
        item('runs', 'Runs', '/runs', 'list-checks'),
        { ...item('schedules', 'Schedules', '/schedules', 'calendar-check'), badge: '3' },
        item('monitoring', 'Synthetic monitoring', '/monitoring', 'pulse'),
      ],
    },
    {
      // Reports are listed in the catalogue (/reports), not one by one in the rail (navigation.yaml listDefinitions).
      key: 'reports',
      label: 'Reports',
      icon: 'chart-bar',
      items: [item('reports-catalog', 'All reports', '/reports', 'chart-bar')],
    },
    {
      key: 'admin',
      label: 'Admin',
      icon: 'gear-six',
      items: [
        item('audit', 'Audit', '/admin/audit', 'scroll'),
        item('appearance', 'Appearance', '/admin/appearance', 'palette'),
      ],
    },
  ],
};
