# 5. Coding standards

The house style for TypeScript in `portal/` and `tests/`. Much of it is enforced; the rest is how the existing code
reads — **match the surrounding code** when in doubt, and treat the guidance below as the direction new code moves in.

## Enforced by tools

| Tool / check                | Where                                       | What it decides                                                                                                                                                                          |
| --------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prettier                    | `.prettierrc.json`, `.editorconfig`         | Formatting: single quotes, trailing commas, 110 columns, 2-space indent, LF. Don't hand-format.                                                                                          |
| ESLint                      | `tooling/lint/eslint.config.js`             | TypeScript recommended rules, React hooks rules, unused vars (prefix `_` to keep one on purpose), raw colours and arbitrary Tailwind values in UI code                                   |
| TypeScript                  | `tsconfig.base.json` + each package         | `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`, ES2023                                                                                                  |
| Guards                      | `tests/guards/`, `.githooks/pre-commit`     | No secrets or tenant values in committable text files; design tokens only in UI code                                                                                                     |
| Commit message / PR title   | `.githooks/commit-msg`, `pr-title` workflow | Conventional Commits with our types and scopes ([guide 10](10-git-and-pull-requests.md))                                                                                                 |
| Dependency audit            | CI                                          | `pnpm audit --audit-level high` fails on high/critical advisories                                                                                                                        |
| Initial-load budget         | CI (`tooling/ci/check-bundle.mjs`)          | The web app's initial JavaScript stays ≤ 250 KB gzip                                                                                                                                     |
| Claude Code after-edit hook | `.claude/hooks/after-edit.mjs`              | On files Claude writes: Prettier, `adminforge validate` for content YAML and runner scripts (reports stale script pins), design-token checks (patterns shared with ESLint and the guard) |

Before every push: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm guard`. `pnpm typecheck` builds nothing,
so it is safe in any checkout; `pnpm build` is not ([CLAUDE.md › Commands](../../CLAUDE.md#commands)).

## TypeScript

- **Types at the edges, inference inside.** Parse every untrusted input with zod at the boundary (request bodies,
  query strings, files, Microsoft responses you depend on) and let the types flow from there.
- **Avoid `any`.** Use `unknown` and narrow it. If you must cast, cast once at the boundary with a comment saying why.
- **Type-only imports** are written `import type { … }` (`verbatimModuleSyntax` requires it).
- **Named exports.** Default exports only where a framework needs them (components loaded with `React.lazy`).
- **Modules with one job.** When a file grows several concerns, split it by responsibility (e.g. `schedules/cron.ts`,
  `sync.ts`, `portal.ts` next to `service.ts`) — some older modules are larger than we'd write today.
- **Pure functions for rules.** Put decisions (is this cron too frequent? may this person manage this schedule?) in
  pure, exported functions that tests can call directly; keep I/O at the edges.
- **Dependency injection over globals.** Services take a `deps` object (store, audit, events, `now`). Time comes from
  `ctx.now()` / an injected `now`, never `new Date()` inside logic you want to test.
- **Errors carry meaning.** Throw `AppError(status, code, message, { hint })` for anything the person should see; let
  unexpected errors reach the central handler. Don't catch and ignore — if a failure is deliberately tolerated, say so
  in a comment and log it.
- **Async:** no floating promises. State-change audits are **awaited** (if the audit can't be written, the change
  fails). Only work that must not break an already-streaming response — the audit of a download or export, the denial
  audit — is fired with `void …catch(log)`.
- **Prefer immutability:** `const`, `readonly` in interfaces, no mutation of inputs.
- **Node built-ins** are imported with the `node:` prefix (`node:crypto`, `node:fs`).

## Error messages and UI copy

Errors are written for the person in front of the browser (CLAUDE.md rule 10):

- `message` says **what happened** in plain language; `hint` says **what to do** (which role or group, licence,
  setting, or action). Every error carries a reference (the correlation id) automatically.
- No raw JSON, stack traces, header names, endpoints or environment keys in errors a user sees. Environment keys and
  CLI commands are fine only in setup errors meant for administrators (`*_not_configured`).
- Error codes are `snake_case` and specific (`cron_too_frequent`, not `bad_input`). Add new ones to
  `docs/troubleshooting.md` and to the endpoint's entry in `docs/api.md`.
- Copy everywhere is sentence case, uses plain verbs, names things by what people control ("Schedule", "Pause
  changes"), and keeps the same name through a flow (a "Create schedule" button → "Schedule created").

```ts
throw new AppError(400, 'cron_too_frequent', 'Reports can run at most once an hour.', {
  hint: 'Pick an hourly, daily, weekly or monthly cadence, or a custom pattern with at least an hour between runs.',
});
```

## Comments

- Every non-trivial module starts with a short block comment: what it is, the rule it implements, and the decision it
  follows (ADR or requirement number) — see `portal/apps/api/src/schedules/service.ts` or `delivery/notifier.ts`.
- Comment the **why** — the constraint, the attack it prevents, the Microsoft quirk — not the what.
- JSDoc on exported functions and interface fields whose meaning isn't obvious from the name.
- Match the comment density of the file you're in. No commented-out code, no `TODO` without a backlog entry.

## Logging

- Use the request's or process's logger (`request.log`, the injected `log`), never `console.log` in services (CLI
  scripts may print to the console).
- Log objects, not interpolated strings: `log.warn({ schedule: key, err }, 'message')`. Errors go through the
  serializers in `portal/apps/api/src/logging.ts`, which strip bound database values; the worker and scheduler log
  through `safeLogFields`; `/api` query strings are redacted before they reach a log line.
- Never log tokens, cookies, request bodies, params, email addresses, or Microsoft response bodies.
- Audit is not logging: state changes go to the audit log ([API guide](06-api-guide.md#6-audit)).

## Configuration

- A new key is added to the zod schema in `portal/apps/api/src/config.ts` (runner keys:
  `portal/apps/runner/src/config.ts`) **and** documented in `config/example.env` with a comment and a safe
  default.
- Content expressions can read only non-secret `AF_*` keys (`${ env.X }`, filtered in
  `portal/apps/api/src/datasources/env.ts`) — never secrets, webhooks, passwords or keys.
- Defaults must be safe: a missing optional key turns a feature off with a clear `*_not_configured` error, never on.

## Dependencies between modules

- Dependencies point down: apps → packages, never the reverse ([Repository map](03-repository-map.md)).
- `portal/` never imports a test library or anything from `tests/`.
- Shared contracts (API shapes, content schemas) live in `@adminforge/schemas` so the API, web and tests agree.
- Tools (the CLI, the scheduler, live scripts) use the API only through its documented entry points
  `@adminforge/api/tooling` and `@adminforge/api/tooling/scheduler` — never `@adminforge/api/src/...` (tests may, they
  test internals).
- Reuse before adding: search for an existing helper (`rg "export function <verb>" portal`) before writing one.
  GUIDs: `isGuid` from `@adminforge/schemas` (a guard refuses a new regex); byte sizes: `formatBytes` from
  `@adminforge/widgets`; abortable waits: `abortableSleep` / `abortableDelay` from `@adminforge/connectors`.

## Performance habits

- Push filtering to the source (`$filter`, `$select`, KQL `where`), not into transforms or loops after the fact.
- Stream large outputs (exports, artifacts) instead of building them in memory.
- Respect the existing limits (outbound concurrency, export row caps, the 250 ms transform budget, the bundle budget)
  rather than raising them.

## Read next

[API guide](06-api-guide.md).
