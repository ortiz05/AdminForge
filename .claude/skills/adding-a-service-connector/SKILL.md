---
name: adding-a-service-connector
description: Use when AdminForge must call a Microsoft API or external service it doesn't support yet, or one of your own Entra-secured Azure Functions/APIs, or when a read-only POST endpoint is being blocked by the request policy.
---

# Adding a service or connection

## Overview

Every outbound call goes through `portal/apps/api/src/execution/outbound.ts`: request policy (default-deny in read
mode) → token for the identity → connector in `portal/packages/connectors`. Your own Entra-secured APIs are
**connections** (content), not code.

## Your own API / Azure Function

1. `pnpm adminforge new connection <section>/<name>`: `baseUrl: ${env.X}`, `audience: ${env.Y}` (add both keys to
   `config/example.env`), named `operations` with `method`, `path`, `mode: read|write`.
2. Grant the Read/Write apps delegated access to that API's scope (add to provisioning; `provision entra`).
3. Use it from content: datasource `source: function` / step `type: function` with `connection` + `operation`.

## A new Microsoft endpoint on an existing service

- Read-only POST (e.g. a `…/query`, `getByIds`)? Add it to `READ_POSTS` in `portal/packages/connectors/src/policy.ts`
  with an anchored regex, plus a test in `tests/unit/connectors/policy.test.ts`. If the response contains secrets,
  strip them in the executor and audit the read.
- Writes are never allowlisted — they come from content `mode: write`.

## A new service (new token audience)

1. `ServiceId` in `connectors/src/types.ts`; client in `connectors/src/<service>.ts` (built on `createHttpClient`:
   retries, Retry-After, normalised `ApiError`); fixture routing in `fixtures.ts`.
2. Resource scope in `apps/api/src/auth/token-broker.ts`; policy rules; executor dispatch in `outbound.ts`.
3. Delegated permission on the Read/Write apps + application permission on the automation identity (provisioning
   catalog). Licence notes in `docs/licensing-review.md`.
4. Tests in `tests/unit/connectors/` (fake fetch) and `tests/unit/api/`.
