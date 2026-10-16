import { NewsListQuery } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { hasRole, requireRole, requireSession } from '../auth/guards';
import type { SessionRecord } from '../auth/session-store';
import type { AppContext } from '../context';
import { AppError } from '../errors';
import type { NewsReader } from '../news/service';
import type { SchedulesModule } from '../schedules/module';

/**
 * News and changes (docs/plans/2026-10-15-news-and-changes.md) — every route needs Portal.Reader; items whose audience
 * the caller lacks (e.g. Message Center data-privacy posts → Portal.Admin) are invisible:
 * - GET /api/news?area&kind&feed&tag&q&days&breaking&unread&cursor&limit → NewsListResponse (newest activity first)
 * - GET /api/news/summary → NewsSummaryResponse (unread counts, up to 5 breaking items, feed statuses; the reason a
 *   feed failed only for Portal.Operator)
 * - GET /api/news/:id → NewsItemDto (404 news_not_found)
 * "Read" is the person's prefs.newsSeenAt (PUT /api/me/prefs).
 */

const ACTION = 'News and changes';

const FIELD_HINT: Record<string, string> = {
  area: 'area is one of identity, m365, endpoint, security, azure or platform.',
  kind: 'kind is one of incident, advisory, maintenance, security, change, retirement, feature, preview, release or info.',
  feed: 'feed is a feed key such as feeds.azure-updates.',
  tag: 'tag is a lower-case service tag such as exchange or graph-api.',
  q: 'Search text is at most 200 characters.',
  days: 'days is a whole number from 1 to 730.',
  breaking: 'breaking is true or false.',
  unread: 'unread is true or false.',
  cursor: 'Reload the list to start from the newest items.',
  limit: 'limit is a whole number from 1 to 100.',
};

async function reader(ctx: AppContext, session: SessionRecord): Promise<NewsReader> {
  const prefs = await ctx.prefs.get(session.userOid);
  const seen = prefs.newsSeenAt ? new Date(prefs.newsSeenAt) : null;
  return { roles: session.roles, seenAt: seen && Number.isFinite(seen.getTime()) ? seen : null };
}

export function newsRoutes(api: FastifyInstance, ctx: AppContext, schedules: SchedulesModule) {
  api.get('/news', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', ACTION);
    const parsed = NewsListQuery.safeParse(request.query ?? {});
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? '');
      throw new AppError(400, 'invalid_request', 'The News and changes filters aren’t valid.', {
        hint: FIELD_HINT[field] ?? 'Clear the filters and try again.',
      });
    }
    return schedules.news.list(await reader(ctx, session), parsed.data);
  });

  api.get('/news/summary', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', ACTION);
    return schedules.news.summary(await reader(ctx, session), {
      showErrors: hasRole(session, 'Portal.Operator'),
    });
  });

  api.get<{ Params: { id: string } }>('/news/:id', async (request) => {
    const session = requireSession(request);
    requireRole(session, 'Portal.Reader', ACTION);
    const item = await schedules.news.get(await reader(ctx, session), String(request.params.id));
    if (!item)
      throw new AppError(404, 'news_not_found', 'That news item isn’t available.', {
        hint: 'It may have aged out, or it needs a role you don’t have. Open News and changes for the current list.',
      });
    return item;
  });
}
