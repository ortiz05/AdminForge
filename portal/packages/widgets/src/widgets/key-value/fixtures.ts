import { DAY, guid, ago } from '../../lib/fixtures';
import type { KeyValueConfig } from './schema';

/** Story data for the keyValue widget. */
export const keyValueFixtures = {
  user: {
    config: {
      widget: 'keyValue',
      title: 'Profile',
      data: 'user',
      fields: [
        { field: 'userPrincipalName', label: 'Sign-in name' },
        { field: 'id', label: 'Object id', kind: 'id' },
        { field: 'accountEnabled', label: 'Sign-in', kind: 'status', map: { true: ['ok', 'Allowed'], false: ['crit', 'Blocked'] } },
        { field: 'department', label: 'Department' },
        { field: 'onPremisesSyncEnabled', label: 'Synced from on-premises', kind: 'boolean' },
        { field: 'createdDateTime', label: 'Created', kind: 'datetime' },
      ],
    } satisfies KeyValueConfig,
    value: {
      id: guid(1),
      userPrincipalName: 'adele.vance@example.com',
      accountEnabled: true,
      department: 'Retail',
      onPremisesSyncEnabled: false,
      createdDateTime: ago(400 * DAY),
    },
  },
};
