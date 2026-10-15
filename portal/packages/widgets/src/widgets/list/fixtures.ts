import { HOUR, MIN, ago } from '../../lib/fixtures';
import type { ListConfig } from './schema';

/** Story data for the list widget. */
export const listFixtures = {
  incidents: {
    config: {
      widget: 'list',
      title: 'Open incidents',
      data: 'incidents.value',
      primary: 'displayName',
      secondary: 'createdDateTime',
      secondaryFormat: 'relativeTime',
      status: {
        field: 'severity',
        map: { high: ['crit', 'High'], medium: ['warn', 'Medium'], low: ['info', 'Low'] },
      },
      href: "${ '/p/security.incident?id=' & row.id }",
      limit: 8,
    } satisfies ListConfig,
    rows: [
      {
        id: 'inc-1042',
        displayName: 'Impossible travel for adele.vance@example.com',
        severity: 'high',
        createdDateTime: ago(25 * MIN),
      },
      {
        id: 'inc-1041',
        displayName: 'Mass download from SharePoint site Finance',
        severity: 'medium',
        createdDateTime: ago(3 * HOUR),
      },
      {
        id: 'inc-1039',
        displayName: 'Suspicious inbox rule created',
        severity: 'low',
        createdDateTime: ago(9 * HOUR),
      },
    ],
  },
};
