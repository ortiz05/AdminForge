---
name: adding-an-api-route
description: Use when AdminForge needs new backend behaviour that content cannot express — a new /api endpoint, server-side computation, or integration in portal/apps/api.
---

# Adding an API route

## Overview

The BFF is Fastify (`portal/apps/api/src`). Everything a handler needs is on `AppContext` (`src/context.ts`):
config, sessions, `broker`, `outbound`, `definitions`, `audit`, `events`, `database`. Content-driven features usually
need **no** new route — check that first.

## Steps

1. Contract first: zod request/response schemas in `portal/packages/schemas/src/` (exported), so web and tests share
   them. Errors use `AppError` → `ApiErrorBody` (`code`, `message`, `hint`, optional `detail`). Write them for the
   person in front of the browser: `message` says what happened, `hint` what to do next (which role/group, licence,
   or action); no header names, endpoints or env keys in either. Browser navigations that can fail (links, downloads)
   are redirected to the public problem page by `registerErrorHandler` — add the path there and its copy in
   `portal/apps/web/src/pages/public/sign-in-problems.ts`.
2. Route file `src/routes/<area>.ts`; register it in `src/app.ts` inside the `/api` prefix block.
3. Guards: the `/api` block already requires a session, plus the CSRF header on every non-GET. In the handler, get the
   session with `requireSession(request)` and check roles with `requireRole(session, 'Portal.…', '<what it does>')`
   (`src/auth/guards.ts`).
4. Outbound calls only via `ctx.outbound.execute(identity, call)` — never `fetch` Microsoft directly (that would bypass
   the read/write policy, tokens, CAE handling, and provenance).
5. Audit every state change: `ctx.audit.append({ ...auditActor(ctx, request, session), action, target…, result })`.
6. DB changes (one SQLite file, ADR-016): edit `src/db/schema.ts` (drizzle `sqlite-core`), `pnpm --filter
@adminforge/api db:generate`, review the SQL in `drizzle/` (the API applies it at start; `db:migrate` by hand);
   migrations only add, never edit applied ones. Write transactions are `writeTx(db, (tx) => …)` (`BEGIN IMMEDIATE`)
   and **synchronous** — `.get()`/`.all()`/`.run()` inside, never `await`; no Postgres-only SQL (`ILIKE`,
   `DISTINCT ON`, `::casts`, `FOR UPDATE`) — `tests/guards/sqlite-only.test.ts` refuses both. An append-only table gets
   `BEFORE UPDATE`/`DELETE` triggers like `drizzle/0001_append_only.sql`. State another process changes reaches
   browsers through a signal (`ctx.database.signals`), published after the commit.
7. Config: new keys in `src/config.ts` (zod) **and** `config/example.env` with a comment.
8. Tests: `tests/api/<area>.test.ts` with `app.inject` (memory stores) and DB-backed `tests/api/<area>-db.test.ts` on
   a temporary SQLite file (`tests/api/db.ts` `testDatabasePath()`; they never skip); unit tests in
   `tests/unit/api/`.
9. Check: `pnpm --filter @adminforge/api typecheck`, api + unit projects, `pnpm guard`, `pnpm lint`.
10. Never loosen the Content-Security-Policy (`helmet` in `src/app.ts`): `script-src` stays `'self'` — no
    `'unsafe-eval'` or `'unsafe-inline'` for scripts (styles keep `'unsafe-inline'`, an accepted risk in
    `docs/decisions.md`). If a web dependency needs eval, fix the dependency (adding-a-widget, step 9).
