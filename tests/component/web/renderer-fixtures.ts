/**
 * Synthetic page definitions and datasource results for the renderer component tests (Example Org, example.com,
 * generated GUIDs). Independent of portal/content so the tests don't move when content does.
 */

export const guid = (n: number) => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const USERS_PAGE = {
  kind: 'page',
  id: 'test.users',
  version: '1.0.0',
  sha256: 'x',
  title: 'People',
  summary: 'Synthetic people for renderer tests.',
  owner: 'test',
  template: 'list-detail',
  nav: { section: 'identity', label: 'People' },
  params: {
    q: { type: 'string', default: '', label: 'Search', placeholder: 'Name or sign-in name' },
    userType: {
      type: 'enum',
      values: ['All', 'Member', 'Guest'],
      default: 'All',
      label: 'Type',
      facet: true,
    },
    department: { type: 'string', label: 'Department', facet: true },
  },
  filters: {
    search: 'q',
    facets: ['userType', 'department'],
    advanced: {
      dialect: 'odata',
      fields: [
        { field: 'department', label: 'Department', type: 'string', operators: ['eq', 'startsWith'] },
        { field: 'createdDateTime', label: 'Created', type: 'date', operators: ['ge', 'le'] },
        {
          field: 'profileType',
          label: 'Profile type',
          type: 'enum',
          values: ['RegisteredDevice', 'Printer'],
        },
      ],
    },
  },
  savedViews: { enabled: true, shared: true, presets: [{ name: 'Guests', params: { userType: 'Guest' } }] },
  datasources: {
    users: { source: 'graph', request: { method: 'GET', path: '/users' }, paging: 'cursor' },
    counts: { source: 'graphBatch', requests: { members: { method: 'GET', path: '/users/$count' } } },
    unused: { source: 'static', data: 1 },
  },
  layout: [
    { widget: 'kpi', data: 'counts.members', label: 'Members' },
    { widget: 'kpi', data: 'counts.guests', label: 'Guests', status: "${ value > 0 ? 'warn' : 'ok' }" },
    {
      widget: 'table',
      id: 'people',
      title: 'People',
      data: 'users.value',
      rowKey: 'id',
      selection: 'multi',
      columns: [
        { field: 'displayName', label: 'Name', kind: 'identity', secondary: 'userPrincipalName' },
        {
          field: 'accountEnabled',
          label: 'Sign-in',
          kind: 'status',
          map: { true: ['ok', 'Allowed'], false: ['crit', 'Blocked'] },
        },
        { field: 'userType', label: 'Type', filter: { type: 'facet', param: 'userType' } },
        { field: 'id', label: 'Object id', kind: 'guid', hidden: true },
      ],
      inspect: { page: 'test.person', params: { id: '${ row.id }' } },
      rowActions: [
        {
          playbook: 'identity.disable-user',
          label: 'Block sign-in',
          inputs: { userId: '${ row.id }' },
          when: '${ row.accountEnabled = true }',
        },
      ],
      bulkActions: [
        {
          playbook: 'identity.disable-user',
          label: 'Block sign-in',
          forEach: { inputs: { userId: '${ row.id }' }, concurrency: 5 },
          maxItems: 100,
        },
      ],
    },
    { widget: 'nope', data: 'users' },
  ],
  export: { formats: ['csv', 'xlsx'], fileName: 'people', data: 'users.value', columns: 'visible' },
};

export const PEOPLE = [
  {
    id: guid(1),
    displayName: 'Adele Vance',
    userPrincipalName: 'adele@example.com',
    accountEnabled: true,
    userType: 'Member',
  },
  {
    id: guid(2),
    displayName: 'Diego Siciliani',
    userPrincipalName: 'diego@example.com',
    accountEnabled: false,
    userType: 'Member',
  },
  {
    id: guid(3),
    displayName: 'Jordan Miller',
    userPrincipalName: 'jordan@partner.example.net',
    accountEnabled: true,
    userType: 'Guest',
  },
];

export const PERSON_PAGE = {
  kind: 'page',
  id: 'test.person',
  version: '2.0.0',
  sha256: 'y',
  title: 'Person',
  owner: 'test',
  template: 'entity',
  params: { id: { type: 'guid', hidden: true, required: true } },
  datasources: {
    profile: { source: 'graph', request: { method: 'GET', path: '/users/x' } },
    groups: { source: 'graph', request: { method: 'GET', path: '/users/x/memberOf' } },
  },
  header: {
    title: '${ profile.displayName }',
    subtitle: '${ profile.userPrincipalName }',
    status: "${ profile.accountEnabled ? 'ok' : 'crit' }",
    statusLabel: "${ profile.accountEnabled ? 'Sign-in allowed' : 'Sign-in blocked' }",
    ids: { 'Object id': '${ profile.id }' },
  },
  actions: [
    {
      playbook: 'identity.disable-user',
      label: 'Block sign-in',
      inputs: { userId: '${ params.id }' },
      when: '${ profile.accountEnabled = true }',
    },
    { playbook: 'identity.revoke-sessions', label: 'Revoke sessions', inputs: { userId: '${ params.id }' } },
    { playbook: 'identity.reset-password', label: 'Reset password', inputs: { userId: '${ params.id }' } },
    { playbook: 'identity.reset-mfa', label: 'Reset MFA methods', inputs: { userId: '${ params.id }' } },
    {
      playbook: 'identity.issue-tap',
      label: 'Issue Temporary Access Pass',
      inputs: { userId: '${ params.id }' },
    },
  ],
  tabs: [
    {
      id: 'overview',
      label: 'Overview',
      layout: [
        {
          widget: 'keyValue',
          data: 'profile',
          fields: [
            { field: 'userPrincipalName', label: 'Sign-in name' },
            { field: 'id', label: 'Object id', kind: 'id' },
          ],
        },
      ],
    },
    {
      id: 'groups',
      label: 'Groups',
      layout: [
        { widget: 'table', data: 'groups.value', columns: [{ field: 'displayName', label: 'Group' }] },
      ],
    },
  ],
};

export const REPORT_PAGE = {
  kind: 'report',
  id: 'test.expiry',
  version: '1.0.0',
  sha256: 'z',
  title: 'Credential expiry',
  owner: 'test',
  template: 'report',
  params: {
    days: {
      type: 'enum',
      label: 'Expiring within',
      default: 30,
      values: [
        { value: 30, label: '30 days' },
        { value: 90, label: '90 days' },
      ],
    },
    includeExpired: { type: 'boolean', label: 'Include expired', default: true },
  },
  datasources: { credentials: { source: 'graph', request: { method: 'GET', path: '/applications' } } },
  layout: [
    { widget: 'kpi', data: 'credentials.total', label: 'Credentials' },
    {
      widget: 'table',
      data: 'credentials.rows',
      columns: [
        { field: 'app', label: 'Application' },
        { field: 'daysRemaining', label: 'Days left', kind: 'number' },
      ],
    },
  ],
  export: {
    formats: ['csv'],
    fileName: 'expiry-${ params.days }d',
    data: 'credentials.rows',
    columns: 'all',
  },
};

export const GATED_PAGE = {
  kind: 'page',
  id: 'test.devices',
  version: '1.0.0',
  sha256: 'w',
  title: 'Managed devices',
  owner: 'test',
  template: 'list-detail',
  requires: { licences: ['intune'] },
  datasources: {
    devices: { source: 'graph', request: { method: 'GET', path: '/deviceManagement/managedDevices' } },
  },
  layout: [{ widget: 'table', data: 'devices.value', columns: [{ field: 'deviceName', label: 'Device' }] }],
};

export const DASHBOARD = {
  kind: 'dashboard',
  id: 'test.health',
  version: '1.0.0',
  sha256: 'd',
  title: 'Health',
  owner: 'test',
  template: 'dashboard',
  refresh: 60,
  datasources: {
    health: {
      source: 'graph',
      request: { method: 'GET', path: '/admin/serviceAnnouncement/healthOverviews' },
    },
  },
  layout: [
    {
      widget: 'markdown',
      text: 'Services that need attention: **${ $count(health.value[status != "serviceOperational"]) }**',
    },
    {
      widget: 'statusGrid',
      title: 'Service health',
      data: 'health.value',
      label: 'service',
      status: 'status',
      map: { serviceOperational: ['ok', 'Healthy'], serviceDegradation: ['warn', 'Degraded'] },
    },
  ],
};

export const RESULTS: Record<string, Record<string, unknown>> = {
  users: {
    data: { value: PEOPLE },
    provenance: { service: 'graph', path: '/users', ms: 120 },
    cursor: 'page-2',
  },
  counts: { data: { members: 2, guests: 1 }, provenance: { service: 'graph', path: '/$batch', ms: 80 } },
  profile: {
    data: { ...PEOPLE[0], mail: 'adele@example.com' },
    provenance: { service: 'graph', path: '/users/{id}', ms: 50 },
  },
  groups: {
    data: { value: [{ id: guid(9), displayName: 'SG-Finance' }] },
    provenance: { service: 'graph', path: '/users/{id}/memberOf', ms: 60 },
  },
  credentials: {
    data: {
      total: 2,
      rows: [
        { app: 'Example Portal', daysRemaining: -16 },
        { app: 'Example HR Sync', daysRemaining: 4 },
      ],
    },
    provenance: { service: 'graph', path: '/applications', ms: 90 },
  },
  health: {
    data: {
      value: [
        { service: 'Exchange Online', status: 'serviceDegradation' },
        { service: 'Microsoft Teams', status: 'serviceOperational' },
      ],
    },
    provenance: { service: 'graph', path: '/admin/serviceAnnouncement/healthOverviews', ms: 70 },
  },
};

export const NEXT_PAGE = {
  data: {
    value: [
      {
        id: guid(4),
        displayName: 'Lee Gu',
        userPrincipalName: 'lee@example.com',
        accountEnabled: true,
        userType: 'Member',
      },
    ],
  },
  provenance: { service: 'graph', path: '/users', ms: 100 },
};

export const DEFINITIONS: Record<string, Record<string, unknown>> = {
  'page/test.users': USERS_PAGE,
  'page/test.person': PERSON_PAGE,
  'report/test.expiry': REPORT_PAGE,
  'page/test.devices': GATED_PAGE,
  'dashboard/test.health': DASHBOARD,
};
