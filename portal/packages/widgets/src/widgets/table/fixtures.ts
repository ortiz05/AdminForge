import { DAY, HOUR, MIN, ago, guid } from '../../lib/fixtures';
import type { TableConfig } from './schema';

/** Story data for the table widget: the users list from portal/content (synthetic people). */
export const tableFixtures = {
  users: {
    config: {
      widget: 'table',
      id: 'users',
      data: 'users.value',
      rowKey: 'id',
      selection: 'multi',
      columns: [
        { field: 'displayName', label: 'Name', kind: 'identity', secondary: 'userPrincipalName' },
        {
          field: 'accountEnabled',
          label: 'Status',
          kind: 'status',
          map: { true: ['ok', 'Enabled'], false: ['crit', 'Disabled'] },
        },
        { field: 'userType', label: 'Type', filter: 'facet' },
        { field: 'department', label: 'Department' },
        {
          field: 'signInActivity.lastSignInDateTime',
          label: 'Last sign-in',
          kind: 'relativeTime',
          filter: 'date',
        },
        { field: 'createdDateTime', label: 'Created', kind: 'date', hidden: true },
        { field: 'id', label: 'Object id', kind: 'guid', hidden: true },
      ],
      inspect: { page: 'identity.user', params: { id: '${ row.id }' } },
      rowActions: [
        {
          playbook: 'identity.disable-user',
          label: 'Disable sign-in',
          icon: 'prohibit',
          inputs: { userId: '${ row.id }' },
          when: '${ row.accountEnabled = true }',
        },
        {
          label: 'Open in Entra admin center',
          icon: 'arrow-square-out',
          href: 'https://entra.microsoft.com/#view/users/${ $encode(row.id) }',
        },
      ],
      bulkActions: [
        {
          playbook: 'identity.disable-user',
          label: 'Disable sign-in',
          icon: 'prohibit',
          forEach: { inputs: { userId: '${ row.id }' }, concurrency: 5 },
          maxItems: 100,
          when: '${ $count(rows[accountEnabled = true]) > 0 }',
        },
      ],
    } satisfies TableConfig,
    rows: [
      {
        id: guid(1),
        displayName: 'Adele Vance',
        userPrincipalName: 'adele.vance@example.com',
        accountEnabled: true,
        userType: 'Member',
        department: 'Retail',
        signInActivity: { lastSignInDateTime: ago(5 * MIN) },
        createdDateTime: ago(400 * DAY),
      },
      {
        id: guid(2),
        displayName: 'Diego Siciliani',
        userPrincipalName: 'diego.siciliani@example.com',
        accountEnabled: false,
        userType: 'Member',
        department: 'HR',
        signInActivity: { lastSignInDateTime: ago(40 * DAY) },
        createdDateTime: ago(900 * DAY),
      },
      {
        id: guid(3),
        displayName: 'Grady Archie',
        userPrincipalName: 'grady.archie@example.com',
        accountEnabled: true,
        userType: 'Member',
        department: 'R&D',
        signInActivity: null,
        createdDateTime: ago(30 * DAY),
      },
      {
        id: guid(4),
        displayName: 'Jordan Miller',
        userPrincipalName: 'jordan.miller_partner.example#EXT#@example.com',
        accountEnabled: true,
        userType: 'Guest',
        department: null,
        signInActivity: { lastSignInDateTime: ago(3 * HOUR) },
        createdDateTime: ago(12 * DAY),
      },
      {
        id: guid(5),
        displayName: 'Lee Gu',
        userPrincipalName: 'lee.gu@example.com',
        accountEnabled: true,
        userType: 'Member',
        department: 'Finance',
        signInActivity: { lastSignInDateTime: ago(2 * DAY) },
        createdDateTime: ago(700 * DAY),
      },
    ],
  },
};
