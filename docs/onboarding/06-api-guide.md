# 6. API guide

How backend code is structured, so every endpoint looks, fails, authorises, audits and documents itself the same way.
The contract itself — every route, code and limit — is [`docs/api.md`](../api.md); the step-by-step recipe is the
`adding-an-api-route` skill. First ask: **can content do this?** Most features need no new route.

## The shape of a feature

```text
portal/packages/schemas/src/api*.ts         contract: zod request/response schemas (api.ts, api-content.ts,
                                            api-reports.ts, …), exported, shared with web and tests
portal/apps/api/src/routes/<area>.ts        HTTP: parse → guard → call the service → reply. No business rules.
portal/apps/api/src/<feature>/service.ts    rules: roles beyond Reader, validation against content, audit, events
portal/apps/api/src/<feature>/store.ts      persistence interface + in-memory implementation (tests, mock mode)
portal/apps/api/src/<feature>/pg-store.ts   Postgres implementation (Drizzle)
portal/apps/api/src/<feature>/module.ts     wiring: builds the service from AppContext (called in buildApp)
portal/apps/api/src/db/schema.ts            tables; migrations generated into portal/apps/api/drizzle/
tests/api/<area>.test.ts                    app.inject() against memory stores; *-pg.test.ts for Postgres paths
tests/unit/api/<topic>.test.ts              the pure rules
docs/api.md                                 the contract for people
```

Small features keep everything in the route file. Read `routes/views.ts` (contract from `@adminforge/schemas`, role
checks, limits, audit) and `routes/emergency.ts` (conditional update, audit, event) before writing your own;
`routes/schedules.ts` + `schedules/` show the full route/service/store split. Routes are registered in `src/app.ts`
inside the `/api` block (a few through `routes/content.ts`); a feature module is built in `buildApp` and passed to its
route function.

## What every handler does

```ts
api.put('/admin/emergency', async (request) => {
  const session = requireSession(request); // 1. who
  const change = parseBody(EmergencyChange, request.body); // 2. what (zod, strict)
  requireRole(session, 'Portal.Admin', `Resuming ${what}`); // 3. may they (beyond Portal.Reader)
  // 4. the rule, with errors written for people
  if (!reason) throw new AppError(400, 'invalid_request', `Say why you’re pausing ${what}.`, { hint: '…' });
  // 5. the change, safe against concurrent edits (expected version / sha256)
  const saved = await ctx.settings.put(key, value, { expectedVersion: current.version /* … */ });
  if (!saved) throw new AppError(409, 'conflict', 'Someone else … meanwhile.', { hint: 'Reload …' });
  // 6. audit the state change (awaited)
  await ctx.audit.append({ ...auditActor(ctx, request, session), action: 'emergency.paused' /* … */ });
  // 7. tell open browsers
  ctx.events.publish({ type: 'emergency.changed', data: { target, paused } });
  return emergencyState(ctx, session); // 8. the new state, same shape as GET
});
```

### 1–3. Sessions, roles and CSRF

- The `/api` block already requires a session, `Portal.Reader` (except the five shell routes in `READER_EXEMPT`,
  pinned by `tests/api/reader-required.test.ts`) and the `X-AdminForge-CSRF` header on every non-GET. Never register
  API routes outside it, and don't add exemptions. A GET that consumes state (a show-once secret) calls `assertCsrf`.
- Further roles: `requireRole(session, 'Portal.Operator', '<what the person was trying to do>')` — the phrase becomes
  the 403's message, and the hint names the group to join. Roles are flat; check every role you need.
- Content gates add `requires.portalRoles` — the caller needs **every** listed role; use the datasource runner's
  `assertAccess` or the existing helpers rather than re-implementing it.
- Rules about **who** may act on **what** (the creator, an approver who isn't the requester) compare object ids
  (`session.userOid`), never UPNs or display names.

### 2. Validation

- Request bodies and queries are parsed with zod (`parseBody`, `safeParse` on queries). Prefer `.strict()` objects and
  explicit limits (`max`, `min`, regexes) — they are part of the security boundary.
- Path params are validated too (a regex for keys, a UUID check for ids) and an unknown one is a 404, not a 400.
- Never read a parameter the schema didn't declare.
- Free from the platform, don't re-implement: a 256 KiB body limit, `Cache-Control: no-store`, a correlation id on
  every response, and `/api` query values kept out of logs.

### 4. Errors

- `throw new AppError(status, code, message, { hint, detail? })`. The central handler turns it into `ApiErrorBody`
  with the correlation id; never build error JSON by hand.
- Status codes: 200/201 with the resource, 202 when work was queued or needs a second person, 204 for deletes; 400
  invalid input, 401 no session, 403 role/policy/licence, 404 unknown or not visible to this caller, 409 state
  conflict (concurrent change, wrong state, content-owned), 429 limits, 502/504 Microsoft failed or didn't answer,
  503 not configured or paused.
- Calls to Microsoft fail with typed outbound errors. Convert them where you call:
  `try { … } catch (err) { throw outboundAppError(err); }` (`execution/outbound.ts`) — it keeps the executor's hint
  and maps to the shared codes (`upstream_forbidden`, `licence_required`, `throttled`, `upstream_unreachable`, …).
- Copy rules: [Coding standards → errors](05-coding-standards.md#error-messages-and-ui-copy). New codes go in
  `docs/troubleshooting.md` and the endpoint's entry in `docs/api.md`.
- A route a browser **navigates** to (a download, a sign-in round trip) must not answer with raw JSON: add its path to
  the problem-page handling in `registerErrorHandler` (`errors.ts`) and its copy to
  `portal/apps/web/src/pages/public/sign-in-problems.ts`.

### 5. State changes

- Writes to our own database use conditional updates (expected `version`/`sha256`) so two people or two processes
  can't silently overwrite each other; the loser gets a 409 with a "reload" hint.
- Multi-step invariants (count, then insert) run in one transaction, with an advisory lock if a cap must hold under
  concurrency.
- Schema changes: edit `src/db/schema.ts`, run `pnpm --filter @adminforge/api db:generate`, review the SQL in
  `drizzle/`, and add a test. Migrations **only add** (they're applied before the old processes restart) and are
  **never edited** once applied anywhere. A new append-only table also gets its grants in
  `portal/deploy/db/app-role-grants.sql` (the services' role can't update or delete it). Mention the migration in the
  PR's "Risk and rollout".
- Tenant writes are never made from a route: they are `mode: write` steps of published content, executed by the run
  worker. Anything else that writes on someone's behalf calls `ctx.outbound.assertWritable(...)` first (emergency
  stop → 503 `writes_paused`, protected objects → 403 `protected_object`).

### 6. Audit

Every successful state change appends an audit event — awaited, so the change fails if it can't be recorded:

```ts
await ctx.audit.append({
  ...auditActor(ctx, request, session), // actor oid + UPN, session hash, read/write mode, correlation id, ip
  action: 'schedule.created', // <subject>.<event>, past tense for new actions
  targetType: 'schedule',
  targetId: key,
  result: 'success',
  details: { report: ref, cron, timezone }, // ids, names of things, counts — never secrets or tokens
});
```

- Inside services, pass the caller rather than the request: routes build `callerOf(request)` (session, correlation id,
  ip) and services audit with `actorOf(caller)` (`schedules/service.ts`).
- A request that changes nothing appends nothing. Security-relevant **refusals** are audited centrally as
  `request.denied` for the codes in `AUDITED_DENIALS` (`errors.ts`); ordinary 4xx errors aren't audited.
- The audit log is append-only and hash-chained; treat `details` as permanent and visible to administrators. Redact
  params marked `redact: true`.
- Audits of reads that are already streaming (downloads, exports) are fired with `void …catch(log)` so a late audit
  failure can't corrupt the response.

### 7. Events

`ctx.events.publish({ type: '<subject>.<event>', data })` reaches the Server-Sent Event streams of **this** API
process. Events raised in the worker or the scheduler reach browsers only through the relayed Postgres `NOTIFY`
channels (`run_events`, `definitions_changed`, `schedule_events`) — use one of those, or add a relay, for state that
changes outside the API. Data carries keys and flags only; the browser refetches through the normal, authorised
endpoints.

### 8. Responses

- JSON objects, never bare arrays (`{ items, cursor? }` for lists), so fields can be added later.
- Response objects are non-strict for clients: **fields may be added, never removed or renamed.** Changing a shape is a
  new field plus a deprecation, not an edit.
- Lists that can grow page with an opaque `cursor` (base64url of the sort key and id) and a bounded `limit`.
- A write returns the new state in the same shape as the matching GET; deletes return 204.
- Never return tokens, secrets, raw Microsoft bodies, or data the caller's roles don't cover — filter per caller.

## Calling Microsoft

Always `ctx.outbound.execute(identity, call, { correlationId: request.id })` (or the datasource runner built on it):
it enforces the default-deny request policy, picks the delegated Read or Write token (or the automation identity on
unattended paths), carries the correlation id, limits concurrency and maps errors. A read-only `POST` (e.g. `getByIds`,
`checkMemberObjects`) is added to the anchored `READ_POSTS` allow-list in `portal/packages/connectors/src/policy.ts`
with a unit test. Writes need a declared write from published content.

## Rate limits

The global per-IP budget applies to every route. Expensive or abusable routes get their own limit in the route options
(`{ config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }`) and a row in `docs/api.md` → Rate limits.

## Configuration and wiring

New dependencies of a service are passed in through its module from `AppContext` — no imports of global
singletons. New configuration keys: `src/config.ts` **and** `config/example.env` ([Coding
standards](05-coding-standards.md#configuration)).

## Testing an endpoint

`tests/api/` builds the app with memory stores and a mock session (`tests/api/support/app.ts` — `buildTestApp`,
`sessionFor`; the shared test people in `tests/api/support/people.ts`; feature harnesses such as
`tests/api/schedules-helpers.ts` build on them), then calls it with `app.inject`. Cover: the happy path, each refusal code, each role
(including "a Reader is refused"), concurrent-change conflicts, and the audit event. Postgres-specific behaviour
(transactions, locks, migrations) goes in a `*-pg.test.ts` that skips without a database. See [Testing](09-testing.md).

## Before you open the PR

- [ ] Contract in `@adminforge/schemas`, used by the route and the web client
- [ ] Session/role/content-role checks, ids compared by oid; no new Reader or CSRF exemptions
- [ ] zod on every input, limits set, unknown fields refused
- [ ] Errors with message + hint; Microsoft errors through `outboundAppError`; new codes in `docs/troubleshooting.md`
- [ ] Audit event per state change (awaited); new security refusal codes in `AUDITED_DENIALS`; SSE event if browsers
      show the state
- [ ] Rate limit if it's expensive or sends data out
- [ ] Migration additive, tested, grants updated for append-only tables
- [ ] `docs/api.md`: endpoint index and route count, section, rate-limit row, roles table if access changed;
      `docs/access.md` if who-can-do-what changed
- [ ] Tests: happy path, refusals, roles, conflicts, audit
- [ ] `security-reviewer` run (any change under `portal/apps` or `portal/packages/{connectors,engine,expressions}`)

## Read next

[Web guide](07-web-guide.md).
