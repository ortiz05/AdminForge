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
   them. Errors use `AppError` → `ApiErrorBody` (`code`, `message`, `hint`).
2. Route file `src/routes/<area>.ts`; register it in `src/app.ts` inside the `/api` prefix block.
3. Guards: `requireSession` (GET) / `requireSessionWithCsrf` (state-changing), `requireRole(session, 'Portal.…')`.
4. Outbound calls only via `ctx.outbound.execute(identity, call)` — never `fetch` Microsoft directly (that would bypass
   the read/write policy, tokens, CAE handling, and provenance).
5. Audit every state change: `ctx.audit.append({ ...auditActor(ctx, request, session), action, target…, result })`.
6. DB changes: edit `src/db/schema.ts`, `pnpm --filter @adminforge/api db:generate`, `db:migrate`; never edit applied
   migrations.
7. Config: new keys in `src/config.ts` (zod) **and** `config/example.env` with a comment.
8. Tests: `tests/api/<area>.test.ts` with `app.inject` (memory stores) and DB-backed tests that skip when Postgres is
   down; unit tests in `tests/unit/api/`.
9. Check: `pnpm --filter @adminforge/api typecheck`, api + unit projects, `pnpm guard`, `pnpm lint`.
