import { CreateViewRequest, UpdateViewRequest } from '@adminforge/schemas';
import type { FastifyInstance } from 'fastify';
import { hasRole, requireSession } from '../auth/guards';
import { auditActor, type AppContext } from '../context';
import { PAGE_KINDS } from '../datasources/executor';
import { AppError, parseBody } from '../errors';
import type { ViewRecord } from '../views/store';

const MAX_VIEWS_PER_PAGE = 100;

/** API shape of a saved view. `owner` is the owner's object id; `mine` says whether the caller owns it. */
export interface SavedView {
  id: string;
  page: string;
  name: string;
  state: Record<string, unknown>;
  shared: boolean;
  owner: string;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

const toView = (v: ViewRecord, userOid: string): SavedView => ({
  id: v.id,
  page: v.pageKey,
  name: v.name,
  state: v.state,
  shared: v.shared,
  owner: v.userOid,
  mine: v.userOid === userOid,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

export function viewRoutes(api: FastifyInstance, ctx: AppContext) {
  /** Personal views plus views others shared, for one page. */
  api.get<{ Querystring: { page?: string } }>('/views', async (request) => {
    const session = requireSession(request);
    const page = request.query.page;
    if (!page) throw new AppError(400, 'invalid_request', 'Pass ?page=<page key>.');
    const views = await ctx.views.list(page, session.userOid);
    return { items: views.map((v) => toView(v, session.userOid)) };
  });

  api.post('/views', async (request, reply) => {
    const session = requireSession(request);
    const body = parseBody(CreateViewRequest, request.body);
    const page = await ctx.definitions.resolveAny(PAGE_KINDS, body.page);
    const spec = page.def.savedViews;
    if (spec?.enabled === false) throw new AppError(400, 'views_disabled', `${body.page} does not offer saved views.`);
    if (body.shared && spec?.shared === false) throw new AppError(400, 'views_not_shareable', `${body.page} does not allow shared views.`);
    const own = await ctx.views.own(body.page, session.userOid);
    if (own.length >= MAX_VIEWS_PER_PAGE) throw new AppError(409, 'too_many_views', `You already have ${MAX_VIEWS_PER_PAGE} views on this page; delete one first.`);
    if (own.some((v) => v.name.toLowerCase() === body.name.toLowerCase())) throw new AppError(409, 'view_exists', `You already have a view named "${body.name}".`);
    const view = await ctx.views.create({ userOid: session.userOid, pageKey: body.page, name: body.name, state: body.state, shared: body.shared ?? false }, ctx.now());
    await ctx.audit.append({ ...auditActor(ctx, request, session), action: 'view.created', targetType: 'view', targetId: view.id, result: 'success', details: { page: body.page, name: body.name, shared: view.shared } });
    return reply.status(201).send(toView(view, session.userOid));
  });

  api.patch<{ Params: { id: string } }>('/views/:id', async (request) => {
    const session = requireSession(request);
    const body = parseBody(UpdateViewRequest, request.body);
    const view = await ctx.views.get(request.params.id);
    if (!view || (view.userOid !== session.userOid && !view.shared)) throw new AppError(404, 'view_not_found', 'No such view.');
    if (view.userOid !== session.userOid) throw new AppError(403, 'forbidden', 'Only the owner can change a view. Save a copy instead.');
    if (body.shared) {
      const page = await ctx.definitions.resolveAny(PAGE_KINDS, view.pageKey).catch(() => null);
      if (page?.def.savedViews?.shared === false) throw new AppError(400, 'views_not_shareable', `${view.pageKey} does not allow shared views.`);
    }
    if (body.name && body.name.toLowerCase() !== view.name.toLowerCase()) {
      const own = await ctx.views.own(view.pageKey, session.userOid);
      if (own.some((v) => v.id !== view.id && v.name.toLowerCase() === body.name!.toLowerCase())) throw new AppError(409, 'view_exists', `You already have a view named "${body.name}".`);
    }
    const updated = (await ctx.views.update(view.id, body, ctx.now()))!;
    await ctx.audit.append({
      ...auditActor(ctx, request, session),
      action: 'view.updated',
      targetType: 'view',
      targetId: view.id,
      result: 'success',
      details: { page: view.pageKey, changed: Object.keys(body), shared: updated.shared },
    });
    return toView(updated, session.userOid);
  });

  /** Owners delete their views; Portal.Admin can also remove views others shared. */
  api.delete<{ Params: { id: string } }>('/views/:id', async (request, reply) => {
    const session = requireSession(request);
    const view = await ctx.views.get(request.params.id);
    if (!view || (view.userOid !== session.userOid && !view.shared)) throw new AppError(404, 'view_not_found', 'No such view.');
    if (view.userOid !== session.userOid && !hasRole(session, 'Portal.Admin')) throw new AppError(403, 'forbidden', 'Only the owner (or a portal admin) can delete a shared view.');
    await ctx.views.delete(view.id);
    await ctx.audit.append({ ...auditActor(ctx, request, session), action: 'view.deleted', targetType: 'view', targetId: view.id, result: 'success', details: { page: view.pageKey, name: view.name, owner: view.userOid } });
    return reply.status(204).send();
  });
}
