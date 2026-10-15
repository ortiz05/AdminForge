# AdminForge tests

Every AdminForge test and every test-only dependency lives here (`@adminforge/tests`); runtime code in `portal/` never
imports a test library. Test files mirror what they test (`unit/<package>/…`, `component/<package or area>/…`). Add a
**new** file for new behaviour rather than appending to shared suites such as `content/validate-all.test.ts`.

## Projects

The vitest projects are defined in `vitest.config.ts`; each one maps to a folder.

| Project     | Folder                     | Environment                                    | What it covers                                                                                           |
| ----------- | -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `unit`      | `unit/<package>/`          | node                                           | Pure logic per package: api, cli, connectors, design-tokens, engine, expressions, runner, scheduler, …   |
| `component` | `component/<area>/`        | jsdom (`component/setup.ts`)                   | React components: `ui` primitives, widgets, web pages, Query Studio; `axe` checks via `component/axe.ts` |
| `api`       | `api/`                     | node (`api/setup.ts`), files run one at a time | BFF routes through Fastify `inject` with a mock session; DB-backed suites (see below)                    |
| `content`   | `content/`                 | node                                           | Every definition in `portal/content` validates; widget configs; focused tests for content-specific logic |
| `guards`    | `guards/`                  | node                                           | No secrets or tenant-specific values in committable files; design tokens only in UI code                 |
| `live`      | `live/**/*.test.ts` (none) | node                                           | Reserved; the live suite is Playwright (`live/README.md`)                                                |

```bash
pnpm test                       # unit, component, api, content, guards
pnpm guard                      # guards only (also the pre-commit hook)
pnpm --filter @adminforge/tests exec vitest run --project <unit|component|api|content|guards> [path filter]
pnpm --filter @adminforge/tests exec vitest --project component   # watch mode
```

Example: `pnpm --filter @adminforge/tests exec vitest run --project component component/query`.

### API tests and the database

API tests use in-memory stores by default. The DB-backed suites (`*-pg.test.ts`, `pg-stores`, `definitions-db`, part of `views`) use
`TEST_DATABASE_URL` as-is, or create and migrate a separate `adminforge_test` database next to the `DATABASE_URL` from
your env file (so test rows never reach the dev audit chain). When Postgres isn't reachable they skip. Start it with
`pnpm db:up`.

## Guards

`guards/no-tenant-data.test.ts` scans every committable file (tracked plus untracked-but-not-ignored) for secrets and
tenant-specific values; `guards/design-tokens.test.ts` rejects raw colours and arbitrary Tailwind values in UI code. They
run in CI and in the pre-commit hook (`.githooks/pre-commit`; `pnpm install` sets `core.hooksPath`, or run
`git config core.hooksPath .githooks`). Never bypass them with `--no-verify`.

## Fixtures

- `fixtures/<service>/…` (`graph`, `arm`, `resourceGraph`, `logAnalytics`, `runner`, `hosts`): synthetic connector
  responses for `DATA_MODE=fixtures` (the API's default `ADMINFORGE_FIXTURES_DIR`), the e2e content backend and the
  API/content tests. The file naming scheme and the `$fixture` variant format are documented at the top of
  `portal/packages/connectors/src/fixtures.ts`. Resource Graph and Log Analytics queries usually pick their
  variant with a `// af:<id>` comment on the first query line (`match.bodyIncludes`).
- Data is synthetic only: `Example Org`, `example.com`, generated GUIDs. `pnpm adminforge new …` writes a fixture stub;
  `pnpm adminforge fixtures record <page>` reads a page live (read-only, automation identity) and writes sanitized
  fixtures.
- `e2e/fixtures/`: API payloads the Playwright specs answer with.

## End-to-end and visual (Playwright)

```bash
pnpm test:e2e                                                                  # all specs
pnpm --filter @adminforge/tests exec playwright test -c e2e/playwright.config.ts query.spec.ts
pnpm --filter @adminforge/tests exec playwright test -c e2e/playwright.config.ts --update-snapshots   # intended UI changes only
```

- Uses the **system Chrome** (`channel: 'chrome'`); Playwright downloads no browser.
- Starts only the Vite dev server (`pnpm --filter @adminforge/web dev`, reused if one already runs on :5173). `/api`
  and `/auth` calls are answered in the browser (`e2e/support/mock-api.ts`, `mock-automation.ts`); content specs route
  definitions, datasources and exports to a small local BFF process (`e2e/support/backend-server.ts`: real content and
  transforms, synthetic fixtures, mock session, no network, no database). The clock is pinned for stable screenshots.
- Visual baselines (`visual.spec.ts`, `automation-visual.spec.ts` and the screenshot assertions in other specs) live in
  `e2e/__screenshots__/<spec>/`; failures and diffs go to `test-results/e2e`. Look at the images before updating a
  baseline.

## PowerShell runner (Pester)

`runner/pester/` holds the runner module tests (`AdminForge.Runner.Tests.ps1`) and the content script tests
(`Scripts.Tests.ps1`, with stub cmdlets). Needs PowerShell 7.4+; `run.ps1` installs the pinned Pester version into the
runner's module directory if it is missing:

```bash
pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1
```

## Content definitions

Playbook and runbook `tests:` blocks run with `pnpm adminforge test [pattern]` (dry runs with mocked step outputs);
`pnpm adminforge validate` checks schemas, references, expressions and env keys. The `content` project also validates
everything on every `pnpm test`.

## Live (real tenant)

Never in CI. See `live/README.md`.
