---
name: adding-an-api-route
description: Use when AdminForge needs new backend behaviour that content cannot express — a new /api endpoint, server-side computation, or integration in portal/apps/api.
---

# Adding an API route

## Overview

The BFF is Fastify (`portal/apps/api/src`), and the same process is the run worker and the scheduler (ADR-016).
Everything a handler needs is on `AppContext` (`src/context.ts`): config, sessions, `broker`, `outbound`,
`definitions`, `audit`, `events`, `database`. Conventions for people: `docs/onboarding/06-api-guide.md`.

## When not to use

- A page, report, playbook, schedule or probe — content features need **no** new route (`adding-a-page-or-report`,
  `adding-a-playbook`, `adding-a-schedule-or-probe`).
- A generic write proxy or an endpoint that calls Microsoft for the browser — never; writes come only from published
  content (`CLAUDE.md` non-negotiable 6).
- A new Microsoft service or read-only POST → `adding-a-service-connector`; only a new setting →
  `adding-a-configuration-key`.

## Steps

1. Contract first: zod request/response schemas in `portal/packages/schemas/src/` (exported), so web and tests share
   them. Parse bodies with `parseBody(schema, body)` (`src/errors.ts`): it words zod issues in plain phrases (keep a
   schema's own message for anything special). Errors use `AppError` → `ApiErrorBody` (`code`, `message`, `hint`,
   optional `detail`); common codes get `DEFAULT_HINTS` when no hint is given. Write them for the person in front of
   the browser: `message` says what happened, `hint` what to do next (which role/group, licence, or action); no header
   names, endpoints or env keys in either. Browser navigations that can fail (links, downloads) are redirected to the
   public problem page by `registerErrorHandler` — add the path there and its copy in
   `portal/apps/web/src/pages/public/sign-in-problems.ts`.
2. Route file `src/routes/<area>.ts`; register it in `src/app.ts` inside the `/api` prefix block, and add it to
   `docs/api.md` (`tests/api/api-doc-index.test.ts` checks every registered route is listed) with its error codes in
   `docs/troubleshooting.md`.
3. Guards: the `/api` block already requires a session, plus the CSRF header on every non-GET. In the handler, get the
   session with `requireSession(request)` and check roles with `requireRole(session, 'Portal.…', '<what it does>')`
   (`src/auth/guards.ts`). Expensive or abusable routes get their own rate limit and a row in `docs/api.md`.
4. Outbound calls only via `ctx.outbound.execute(identity, call)` — never `fetch` Microsoft directly (that would bypass
   the read/write policy, tokens, CAE handling, and provenance).
5. Audit every state change: `ctx.audit.append({ ...auditActor(ctx, request, session), action, target…, result })`.
6. DB changes (one SQLite file, ADR-016): edit `src/db/schema.ts` (drizzle `sqlite-core`),
   `pnpm --filter @adminforge/api db:generate`, review the SQL in `drizzle/` (the API applies it at start; `db:migrate`
   by hand); migrations only add, never edit applied ones. Write transactions are `writeTx(db, (tx) => …)`
   (`BEGIN IMMEDIATE`) and **synchronous** — `.get()`/`.all()`/`.run()` inside, never `await`; no Postgres-only SQL
   (`ILIKE`, `DISTINCT ON`, `::casts`, `FOR UPDATE`) — `tests/guards/sqlite-only.test.ts` refuses both. An append-only
   table gets `BEFORE UPDATE`/`DELETE` triggers like `drizzle/0001_append_only.sql`. State another process changes
   reaches browsers through a signal (`ctx.database.signals`), published after the commit.
7. Config: new keys follow `adding-a-configuration-key` (`src/config.ts` **and** `config/example.env`).
8. Tests: `tests/api/<area>.test.ts` with `app.inject` (memory stores; `tests/api/support/app.ts`) and DB-backed
   `tests/api/<area>-db.test.ts` on a temporary SQLite file (`tests/api/db.ts` `testDatabasePath()`; they never skip);
   unit tests in `tests/unit/api/`. Cover the happy path, each refusal code, each role (a Reader is refused) and the
   audit event.
9. Never loosen the Content-Security-Policy (`helmet` in `src/app.ts`): `script-src` stays `'self'` — no
   `'unsafe-eval'` or `'unsafe-inline'` for scripts (styles keep `'unsafe-inline'`, an accepted risk in
   `docs/decisions.md`).
10. Check: `pnpm --filter @adminforge/api typecheck`, the api and unit projects, `pnpm guard`, `pnpm lint`; then
    `security-reviewer`.

## Done when

- [ ] Contract in `@adminforge/schemas`; the route is in `docs/api.md` and its error codes in `docs/troubleshooting.md`
- [ ] Roles checked server-side, every state change audited, Microsoft reached only through `ctx.outbound`
- [ ] Tests cover the happy path, every refusal code and role, and the audit event; DB behaviour in a `*-db.test.ts`
- [ ] Api typecheck, the api and unit projects, `pnpm guard` and `pnpm lint` pass
- [ ] `security-reviewer` ran and its findings are fixed or answered

## Common mistakes

| Mistake                                               | Fix                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `await` inside `writeTx`                              | Synchronous `.get()`/`.all()`/`.run()` only; do the async work before or after |
| zod's own text, raw JSON or a header name in an error | `parseBody` plus a `message` and `hint` written for the person                 |
| A role check only in the web app                      | `requireRole` in the handler; the UI only hides what the API refuses           |
| A state change without an audit event                 | `ctx.audit.append(…)` with the actor and identity                              |
| A route missing from `docs/api.md`                    | Add its row; `api-doc-index.test.ts` fails otherwise                           |
| Editing an applied migration                          | A new migration that adds; never rewrite one that ran                          |

## See also

- `docs/onboarding/06-api-guide.md`, `docs/api.md`, `docs/troubleshooting.md`, `SECURITY.md`
- `adding-a-configuration-key`, `adding-a-service-connector`, `adding-a-coded-screen`
