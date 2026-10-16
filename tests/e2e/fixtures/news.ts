import type { NavResponse, NewsFeedStatus, NewsItemDto, NewsSummaryResponse } from '@adminforge/schemas';
import { NAV } from './session';

/**
 * News and changes — synthetic items for the component and e2e suites. Titles and summaries are invented (no source
 * text is copied); ids are made up; times are relative to FIXED_NOW (2026-10-15T14:00Z).
 */

const item = (o: Partial<NewsItemDto> & Pick<NewsItemDto, 'id' | 'title' | 'kind'>): NewsItemDto => ({
  feed: 'feeds.example',
  feedTitle: 'Example feed',
  publisher: 'Microsoft',
  externalId: o.id.toUpperCase(),
  summary: '',
  url: 'https://www.microsoft.com/',
  severity: 'normal',
  areas: [],
  tags: [],
  status: null,
  publishedAt: '2026-10-15T08:00:00.000Z',
  updatedAt: null,
  firstSeenAt: o.publishedAt ?? '2026-10-15T08:00:00.000Z',
  changedAt: o.updatedAt ?? o.publishedAt ?? '2026-10-15T08:00:00.000Z',
  actionRequiredBy: null,
  breaking: false,
  unread: false,
  facts: [],
  ...o,
});

export const NEWS_ITEMS: NewsItemDto[] = [
  item({
    id: 'n-incident',
    kind: 'incident',
    severity: 'high',
    title: 'Some users can’t send mail from Outlook on the web',
    summary:
      'Users in some regions see a delay or an error when sending from Outlook on the web. Desktop and mobile clients are not affected. Microsoft is rerouting traffic.',
    feed: 'feeds.m365-service-health',
    feedTitle: 'Microsoft 365 service health',
    externalId: 'EX000123',
    url: 'https://admin.microsoft.com/AdminPortal/home#/servicehealth/:/alerts/EX000123',
    status: 'Service degradation',
    areas: ['m365'],
    tags: ['exchange'],
    publishedAt: '2026-10-15T12:40:00.000Z',
    updatedAt: '2026-10-15T13:20:00.000Z',
    firstSeenAt: '2026-10-15T13:05:00.000Z',
    changedAt: '2026-10-15T13:25:00.000Z',
    breaking: true,
    unread: true,
    facts: [
      { label: 'Feature', value: 'Outlook on the web' },
      { label: 'Classification', value: 'Incident' },
    ],
  }),
  item({
    id: 'n-security',
    kind: 'security',
    severity: 'critical',
    title: 'Security update for an identity synchronisation component',
    summary:
      'An elevation of privilege issue is fixed in the latest release. Update the component on every server that runs it.',
    feed: 'feeds.msrc-security',
    feedTitle: 'Security Update Guide',
    publisher: 'Microsoft Security Response Center',
    externalId: 'CVE-2026-00001',
    url: 'https://msrc.microsoft.com/update-guide/vulnerability/CVE-2026-00001',
    areas: ['identity', 'security'],
    tags: ['entra'],
    publishedAt: '2026-10-15T09:10:00.000Z',
    breaking: true,
    unread: true,
  }),
  item({
    id: 'n-change',
    kind: 'change',
    title: 'Meeting recordings get a default expiry',
    summary:
      'New recordings will expire after a default period unless an administrator sets a different policy.',
    feed: 'feeds.m365-message-center',
    feedTitle: 'Microsoft 365 Message Center',
    externalId: 'MC000101',
    url: 'https://admin.microsoft.com/AdminPortal/home#/MessageCenter/:/messages/MC000101',
    areas: ['m365'],
    tags: ['teams'],
    publishedAt: '2026-10-14T16:00:00.000Z',
    actionRequiredBy: '2026-10-24T00:00:00.000Z',
    breaking: true,
    facts: [{ label: 'Major change', value: 'Yes' }],
  }),
  item({
    id: 'n-retirement',
    kind: 'retirement',
    title: 'Retirement: an older alerting experience in Azure Monitor',
    summary: 'Move alert rules to the current experience before the retirement date.',
    feed: 'feeds.azure-updates',
    feedTitle: 'Azure Updates',
    externalId: 'AZ-500001',
    url: 'https://azure.microsoft.com/updates?id=500001',
    areas: ['azure'],
    tags: ['monitor'],
    publishedAt: '2026-10-14T08:00:00.000Z',
    unread: true,
  }),
  item({
    id: 'n-feature',
    kind: 'feature',
    title: 'Intune: a new compliance setting for device health',
    summary: 'A new setting lets compliance policies require a recent device health report.',
    feed: 'feeds.m365-roadmap',
    feedTitle: 'Microsoft 365 Roadmap',
    externalId: 'RM-400001',
    url: 'https://www.microsoft.com/microsoft-365/roadmap?id=400001',
    status: 'Rolling out',
    areas: ['endpoint'],
    tags: ['intune'],
    publishedAt: '2026-10-13T10:00:00.000Z',
  }),
  item({
    id: 'n-release',
    kind: 'release',
    title: 'ExchangeOnlineManagement 3.9.2',
    summary: 'Bug fixes and reliability improvements for connecting to Exchange Online.',
    feed: 'feeds.powershell-modules',
    feedTitle: 'PowerShell modules',
    publisher: 'PowerShell Gallery',
    externalId: 'ExchangeOnlineManagement@3.9.2',
    url: 'https://www.powershellgallery.com/packages/ExchangeOnlineManagement/3.9.2',
    areas: ['platform'],
    tags: ['powershell', 'exchange'],
    publishedAt: '2026-10-12T19:00:00.000Z',
  }),
  item({
    id: 'n-pnp',
    kind: 'release',
    title: 'PnP.PowerShell 3.2.0',
    summary: 'A community release with new cmdlets and fixes.',
    feed: 'feeds.powershell-modules',
    feedTitle: 'PowerShell modules',
    publisher: 'PnP community',
    externalId: 'PnP.PowerShell@3.2.0',
    url: 'https://www.powershellgallery.com/packages/PnP.PowerShell/3.2.0',
    areas: ['platform'],
    tags: ['powershell', 'sharepoint'],
    publishedAt: '2026-10-12T09:00:00.000Z',
  }),
  item({
    id: 'n-maintenance',
    kind: 'maintenance',
    title: 'Planned maintenance: Azure Functions in one region',
    summary: 'Function apps may restart once during the maintenance window.',
    feed: 'feeds.azure-service-health',
    feedTitle: 'Azure Service Health',
    externalId: 'TRK-0001',
    url: 'https://portal.azure.com/#view/Microsoft_Azure_Health/AzureHealthBrowseBlade/~/plannedMaintenance',
    areas: ['azure'],
    tags: ['functions'],
    publishedAt: '2026-10-11T12:00:00.000Z',
    actionRequiredBy: '2026-11-20T22:00:00.000Z',
  }),
  item({
    id: 'n-graph',
    kind: 'change',
    title: 'Microsoft Graph v1.0: a new property on the user resource',
    summary: 'The property is available in v1.0 after a period in beta.',
    feed: 'feeds.graph-changelog',
    feedTitle: 'Microsoft Graph changelog',
    externalId: 'graph-0001',
    url: 'https://developer.microsoft.com/graph/changelog',
    areas: ['platform', 'identity'],
    tags: ['graph-api'],
    publishedAt: '2026-10-10T07:00:00.000Z',
  }),
];

const feed = (o: Partial<NewsFeedStatus> & Pick<NewsFeedStatus, 'key' | 'title'>): NewsFeedStatus => ({
  publisher: 'Microsoft',
  homepage: 'https://www.microsoft.com/',
  scope: 'public',
  status: 'ok',
  lastRunAt: '2026-10-15T13:05:00.000Z',
  lastSuccessAt: '2026-10-15T13:05:00.000Z',
  pollMinutes: 60,
  newestAt: '2026-10-15T12:00:00.000Z',
  quiet: false,
  items: 3,
  error: null,
  ...o,
});

export const NEWS_FEEDS: NewsFeedStatus[] = [
  feed({
    key: 'feeds.m365-message-center',
    title: 'Microsoft 365 Message Center',
    scope: 'tenant',
    homepage: 'https://admin.microsoft.com/AdminPortal/home#/MessageCenter',
    items: 42,
  }),
  feed({
    key: 'feeds.m365-service-health',
    title: 'Microsoft 365 service health',
    scope: 'tenant',
    homepage: 'https://admin.microsoft.com/AdminPortal/home#/servicehealth',
    items: 4,
  }),
  feed({
    key: 'feeds.azure-service-health',
    title: 'Azure Service Health',
    scope: 'tenant',
    homepage: 'https://portal.azure.com/#view/Microsoft_Azure_Health/AzureHealthBrowseBlade',
    status: 'error',
    error: { code: 'forbidden', message: 'The automation identity can’t read Azure Service Health.' },
    items: 1,
  }),
  feed({
    key: 'feeds.azure-updates',
    title: 'Azure Updates',
    homepage: 'https://azure.microsoft.com/updates',
    items: 61,
  }),
  feed({
    key: 'feeds.m365-roadmap',
    title: 'Microsoft 365 Roadmap',
    homepage: 'https://www.microsoft.com/microsoft-365/roadmap',
    pollMinutes: 360,
    status: 'stale',
    lastSuccessAt: '2026-10-14T20:05:00.000Z',
    items: 37,
  }),
  feed({
    key: 'feeds.graph-changelog',
    title: 'Microsoft Graph changelog',
    homepage: 'https://developer.microsoft.com/graph/changelog',
    newestAt: '2026-08-03T09:00:00.000Z',
    quiet: true,
    items: 12,
  }),
  feed({
    key: 'feeds.msrc-security',
    title: 'Security Update Guide',
    publisher: 'Microsoft Security Response Center',
    homepage: 'https://msrc.microsoft.com/update-guide',
    items: 5,
  }),
  feed({
    key: 'feeds.powershell-modules',
    title: 'PowerShell modules',
    publisher: 'PowerShell Gallery',
    homepage: 'https://www.powershellgallery.com/',
    pollMinutes: 360,
    items: 9,
  }),
];

export function newsSummary(overrides: Partial<NewsSummaryResponse> = {}): NewsSummaryResponse {
  return {
    unread: NEWS_ITEMS.filter((i) => i.unread).length,
    breakingUnread: NEWS_ITEMS.filter((i) => i.breaking && i.unread).length,
    breaking: NEWS_ITEMS.filter((i) => i.breaking),
    lastUpdatedAt: '2026-10-15T13:05:00.000Z',
    seenAt: '2026-10-15T08:30:00.000Z',
    feeds: NEWS_FEEDS,
    ...overrides,
  };
}

/** GET /api/news with the filters the page sends (enough of the server's behaviour for the UI suites). */
export function newsList(params: URLSearchParams, items: NewsItemDto[] = NEWS_ITEMS) {
  const q = params.get('q')?.toLowerCase();
  const out = items.filter(
    (i) =>
      (!params.get('area') || i.areas.includes(params.get('area') as never)) &&
      (!params.get('kind') || i.kind === params.get('kind')) &&
      (!params.get('feed') || i.feed === params.get('feed')) &&
      (!params.get('tag') || i.tags.includes(params.get('tag')!)) &&
      (params.get('breaking') !== 'true' || i.breaking) &&
      (params.get('unread') !== 'true' || i.unread) &&
      (!q || `${i.title} ${i.summary}`.toLowerCase().includes(q)),
  );
  return { items: out, nextCursor: null };
}

/** The navigation with the News and changes item (navigation.yaml puts it in Overview). */
export const NAV_WITH_NEWS: NavResponse = {
  sections: NAV.sections.map((s) =>
    s.key === 'overview'
      ? {
          ...s,
          items: [...s.items, { key: 'news', label: 'News and changes', href: '/news', icon: 'newspaper' }],
        }
      : s,
  ),
};
