import { HOUR, MIN, ago } from '../../lib/fixtures';
import type { TimelineConfig } from './schema';

/** Story data for the timeline widget (directory audit). */
export const timelineFixtures = {
  audit: {
    config: {
      widget: 'timeline',
      heading: 'Recent changes',
      data: 'audit.value',
      ts: 'activityDateTime',
      title: 'activityDisplayName',
      detail: '${ initiatedBy.user.userPrincipalName }',
      status: { field: 'result', map: { success: ['ok', 'Success'], failure: ['crit', 'Failure'] } },
    } satisfies TimelineConfig,
    rows: [
      { id: 'a1', activityDateTime: ago(4 * MIN), activityDisplayName: 'Update user', result: 'success', initiatedBy: { user: { userPrincipalName: 'mock.engineer@example.com' } } },
      { id: 'a2', activityDateTime: ago(2 * HOUR), activityDisplayName: 'Add member to group', result: 'failure', initiatedBy: { user: { userPrincipalName: 'lee.gu@example.com' } } },
      { id: 'a3', activityDateTime: ago(26 * HOUR), activityDisplayName: 'Reset password', result: 'success', initiatedBy: { user: { userPrincipalName: 'adele.vance@example.com' } } },
    ],
  },
};
