---
name: adding-a-service-connector
description: Use when AdminForge must call a Microsoft API or external service it doesn't support yet, or one of your own Entra-secured Azure Functions/APIs, or when a read-only POST endpoint is being blocked by the request policy.
---

# Adding a service or connection

## Overview

Every outbound call goes through `portal/apps/api/src/execution/outbound.ts`: request policy (default-deny in read
mode) → token for the identity → connector in `portal/packages/connectors`. Your own Entra-secured APIs are
**connections** (content), not code. A new Microsoft service is code and needs a `security-reviewer` pass.

## When not to use

- A Graph, ARM, Resource Graph or Log Analytics read that already works → a datasource (`adding-a-page-or-report`).
- A write → content declares it (`mode: write` in a playbook, `adding-a-playbook`); writes are never allowlisted in the
  request policy.
- PowerShell-only services (Exchange, Teams, SharePoint admin) → `adding-a-runner-script`.
- A third-party host for News and changes → `add-news-feed` (its own allow-list).

## Steps

### Your own API or Azure Function

1. `pnpm adminforge new connection <section>/<name>`: `baseUrl: ${env.X}`, `audience: ${env.Y}` (add both keys to
   `config/example.env` — `adding-a-configuration-key`), named `operations` with `method`, `path`,
   `mode: read|write`. The audience must be **your own** app registration (`api://…` or its application id): Microsoft
   first-party audiences (Graph, ARM, Exchange, SharePoint…) are refused, because the token would go to the
   connection's host. An `https://` audience needs its host in `AF_CONNECTION_AUDIENCE_HOSTS`. `scopes` are plain names
   on that audience (e.g. `user_impersonation`), never a URL or another resource's `.default`. Function calls never
   follow redirects, and response bodies are capped (`OUTBOUND_MAX_BYTES`).
2. Grant the Read/Write apps delegated access to that API's scope (add to provisioning; `provision entra`).
3. Use it from content: datasource `source: function` / step `type: function` with `connection` + `operation`, and a
   synthetic fixture for mock mode.

### A new Microsoft endpoint on an existing service

1. Read-only POST (e.g. a `…/query`, `getByIds`)? Add it to `READ_POSTS` in `portal/packages/connectors/src/policy.ts`
   with an anchored regex, plus a test in `tests/unit/connectors/policy.test.ts`.
2. If the response contains secrets, strip them in the executor and audit the read.

### A new service (new token audience)

1. `ServiceId` in `portal/packages/connectors/src/types.ts`; a client in `portal/packages/connectors/src/<service>.ts`
   built on `createHttpClient` (retries with Retry-After spread ±20 %, normalised `ApiError`, the correlation id; it
   drops the headers AdminForge owns before adding the bearer token); fixture routing in `fixtures.ts`.
2. Resource scope in `portal/apps/api/src/auth/token-broker.ts`; policy rules; executor dispatch in `outbound.ts`.
3. Delegated permission on the Read/Write apps + application permission on the automation identity (provisioning
   catalog). Licence notes in `docs/licensing-review.md`.
4. Tests in `tests/unit/connectors/` (fake fetch) and `tests/unit/api/`.

## Done when

- [ ] Read mode stays default-deny: every new `READ_POSTS` entry is anchored, truly read-only and tested
- [ ] Content that uses the connection or service validates and renders from a synthetic fixture in mock mode
- [ ] Provisioning grants exactly the new permissions; `pnpm adminforge validate --scopes` agrees
- [ ] unit and api projects, `pnpm guard` and the package typechecks pass
- [ ] `security-reviewer` ran on the code change and its findings are fixed or answered

## Common mistakes

| Mistake                                                       | Fix                                                                                    |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `fetch` to a Microsoft API from a route or handler            | Always `ctx.outbound.execute(identity, call)`: policy, tokens, CAE and provenance      |
| An unanchored or too-broad `READ_POSTS` regex                 | `^…$` on the exact path; a test that a neighbouring write path is still refused        |
| A connection whose audience is Graph or another Microsoft API | Refused by design: the token would reach the connection's host; use your own app       |
| A connection URL or audience written into the YAML            | `${ env.X }` keys documented in `config/example.env`                                   |
| Setting `Authorization` or the correlation headers in content | AdminForge sets them; `validate`, the executor and the HTTP client refuse or drop them |

## See also

- `SECURITY.md` › Data handling (outbound calls and the request policy); ADR-003 (default-deny request policy)
- `docs/licensing-review.md`; `adding-a-configuration-key`; `adding-an-api-route`
