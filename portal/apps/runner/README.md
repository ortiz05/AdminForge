# PowerShell runner (`@adminforge/runner`)

Runs the PowerShell that Microsoft Graph can't replace — Exchange Online, Teams admin, SharePoint/PnP — for AdminForge,
with the calling engineer's **delegated** tokens. The API sends it signed jobs; each job runs one pinned script from
`portal/content/scripts` in a fresh, single-use `pwsh` process; the answer streams back as signed NDJSON events.

On this host it runs as the `adminforge-runner` user service (loopback only, `dist/main.js`); in a container from
`Dockerfile`. Configuration: the `RUNNER_*` keys and `ADMINFORGE_RUNNER_MODULES_DIR` in `config/example.env`.

## Architecture

```text
API (portal/apps/api)                      runner (this package)
  prepareRunnerJob ──POST /v1/jobs──────▶  Node supervisor (Fastify, src/)
  signed request, sealed tokens              verify HMAC + timestamp, open tokens, resolve + verify script sha256
                                             JobManager → WorkerPool: a pre-forked pwsh (ps/worker.ps1) per job
                  ◀──NDJSON events────────   every line redacted, signed (seq + mac over the request nonce)
                                           pwsh worker: import modules → read one job on stdin → read-only policy
                                             (read mode) → connect services → run script text → exit
```

- **Node host** (`src/`). `server.ts` serves `POST /v1/jobs`, `POST /v1/jobs/:id/cancel` and `GET /healthz`;
  `auth.ts` verifies every request's `AdminForge-HMAC` signature and timestamp (±60 s, nothing signed before the process
  started); `crypto.ts` derives separate keys from `RUNNER_SHARED_KEY` (request MAC, response MAC, token sealing) and
  opens the AES-GCM sealed tokens, which are bound to the job id and timestamp; `scripts.ts` resolves the script under
  the scripts directory (no escapes, no symlinks out) and refuses it unless its sha256 is the one the job pins (409);
  `jobs.ts` admits, queues, times out and cancels jobs; `pool.ts` keeps `RUNNER_POOL_SIZE` warm workers and spawns
  them with a withheld environment (never the shared key) and a throw-away `HOME`/`TMPDIR`; `worker-bridge.ts` hands a
  job to a worker over stdin and relays its events through `redact.ts`; `health.ts` / `health-probe.ts` report health
  and back the container `HEALTHCHECK`. `client.ts`, `protocol.ts` and `index.ts` are the API's side of the protocol.
- **Signed jobs.** The API signs method, path, timestamp and body; tokens never travel in clear (sealed per job) and
  never reach argv, the environment, files or logs. The runner signs each answer event over the API's nonce, so the
  API rejects anything it didn't ask for.
- **Single-use pwsh workers** (`ps/worker.ps1`). A worker imports the pinned modules and reports `ready`, then reads
  exactly one job line on stdin, runs it and exits — no state survives between jobs. Stdout is the protocol channel;
  anything else is diverted to stderr. `ps/powershell.config.json` keeps script-block and module logging (which would
  record tokens) off.
- **Read-only policy.** A read-mode job runs with Read-app tokens, some of which can write (Exchange.Manage,
  SharePoint AllSites.FullControl). Two layers keep it to reads: before anything connects, a static policy over the
  parsed script refuses anything but `Get-*` service commands, the AdminForge helpers and a fixed set of utilities
  (no module-qualified or dynamic calls, reflection, `$env:`, classes, unlisted .NET types…); while it runs, every
  non-`Get` command of every loaded service module is replaced by a constant guard, `Invoke-MgGraphRequest` /
  `Invoke-AzRestMethod` accept only `GET`, and module auto-loading is off. Write-mode jobs (armed session, playbook
  steps with `mode: write`) run without either layer. The rules are in `ReadOnlyPolicy.ps1` — a security boundary:
  change it only with tests in `tests/runner/pester/ReadOnlyPolicy.Tests.ps1` and a security review.

## The `AdminForge.Runner` module (`ps/AdminForge.Runner/`)

The worker imports it for every job, and it is the API content scripts call. `AdminForge.Runner.psm1` sets strict mode and
dot-sources one file per concern into the module's scope; `AdminForge.Runner.psd1` lists the exported functions (the
same list as `Export-ModuleMember`; `tests/runner/pester/ModuleLayout.Tests.ps1` checks both and that every function
lives in one of these files).

| File                 | Functions                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Events.ps1`         | `Write-AdminForgeLog`, `Write-AdminForgeProgress`, `Write-AdminForgeOutput` (scripts); `Set-AdminForgeEventSink`, `Send-AdminForgeEvent`, `Send-AdminForgeStreamRecord` (worker) |
| `Errors.ps1`         | `New-AdminForgeError` (scripts); `Get-AdminForgeErrorCategory`, `Format-AdminForgeMessage`                                                                                       |
| `Inputs.ps1`         | `Get-AdminForgeInput` — typed, bounded inputs                                                                                                                                    |
| `Connections.ps1`    | `Connect-AdminForgeServices` — Graph, Exchange, Teams, SharePoint, Az with the forwarded tokens                                                                                  |
| `ReadOnlyPolicy.ps1` | `Test-` / `Assert-AdminForgeReadOnlyScript`, `Enable-AdminForgeReadOnlyMode`, `Get-AdminForgeMode`                                                                               |

**The live runner loads this module from the checkout for every new job.** A broken edit fails the next job: run the
Pester suite before saving changes on a host whose runner uses this working tree, and keep `FunctionsToExport` and
`Export-ModuleMember` identical.

## Scripts and pins

Scripts live in `portal/content/scripts/<area>/<Verb-Noun>.ps1` (conventions: that folder's README and the
`adding-a-runner-script` skill). Content references a script by path **and** sha256; the runner hashes the file's
bytes, refuses a mismatch, and hands the worker the exact text it hashed (the worker runs that text, not the file).
`adminforge validate` checks every pin in `portal/content` (and the Claude Code after-edit hook runs it whenever a
script changes, listing stale pins with the new hash).

## Pinned modules

`modules.lock.json` pins every PowerShell module version (runtime `modules`, plus `devModules` such as Pester).
`scripts/install-modules.ps1` installs exactly those into `modules/` (git-ignored) or `ADMINFORGE_RUNNER_MODULES_DIR`,
removing unpinned versions; its logic is in `scripts/RunnerModules.ps1`, shared with the Pester runner. Workers put
that directory first on `PSModulePath` (`worker.ps1` does it itself: the image ships `ps/`, not `scripts/`).

```sh
pnpm --filter @adminforge/runner modules:install            # all pins (dev included)
pwsh -File portal/apps/runner/scripts/install-modules.ps1 -Production   # runtime only (the Dockerfile)
pwsh -File portal/apps/runner/scripts/install-modules.ps1 -Name Pester  # just these pins
```

Bump a pin deliberately, re-run the install and the tests below, and check `GET /healthz` (`modules.items[].installed`).

## Testing

```sh
pnpm --filter @adminforge/tests exec pwsh -NoLogo -NoProfile -File runner/pester/run.ps1   # Pester: module, worker, scripts
pnpm --filter @adminforge/tests exec vitest run --project unit unit/runner                 # Node host
pnpm --filter @adminforge/tests test:pwsh                                                  # real pwsh workers + Pester
pnpm exec tsx tests/live/scripts/check-page-datasources.ts m365.mailboxes                   # a real read-only job (live)
```

- `tests/runner/pester/` — the module (events, inputs, connections with mocked `Connect-*`), the worker end to end,
  the read-only policy, module layout, `install-modules.ps1` offline, and every content script with stub cmdlets.
  `run.ps1` installs the pinned Pester when missing.
- `tests/unit/runner/` — signing, sealed tokens, replay, protocol, redaction, pool, server, health probe; a fake worker
  (`fixtures/fake-worker.mjs`) stands in for pwsh; the `*.pwsh.test.ts` files (the `pwsh` project) run the real
  worker (`integration.pwsh.test.ts`) and the Pester suite when pwsh, and for some cases the modules, are installed.
- Live: the commands in `tests/live/README.md` against the validation tenant.

## Layout

| Path                        | What                                                                          |
| --------------------------- | ----------------------------------------------------------------------------- |
| `src/`                      | Node supervisor and the API-side client (above)                               |
| `ps/worker.ps1`             | The single-use worker                                                         |
| `ps/powershell.config.json` | Worker PowerShell settings (`-SettingsFile`): logging policies off            |
| `ps/AdminForge.Runner/`     | The helper module (above)                                                     |
| `scripts/`                  | `install-modules.ps1` and `RunnerModules.ps1` (pinned-module tooling)         |
| `modules.lock.json`         | Pinned module versions                                                        |
| `modules/`                  | Installed pinned modules (git-ignored)                                        |
| `Dockerfile`                | Container image: Node bundle + pwsh + the pinned runtime modules              |
| `tsup.config.ts`            | Bundles `dist/main.js` and `dist/healthcheck.js` with every dependency inside |
