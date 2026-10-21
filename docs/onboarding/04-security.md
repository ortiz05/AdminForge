# 4. Security for contributors

AdminForge holds delegated and application access to Microsoft tenants. A bug here isn't a broken page — it can be a
tenant-wide change nobody intended, or tenant data in the wrong hands. This page is the contributor's view: the rules
you apply every day and when to ask for a review. The full model is [`SECURITY.md`](../../SECURITY.md).

## The rules that are never traded for convenience

**Tenant data and secrets**

1. Nothing tenant-specific in git: tenant, client, subscription or workspace ids, domains, UPNs, names, licence SKUs,
   secrets — not in code, content, fixtures, docs, screenshots, commit messages or PR descriptions. Content refers to
   installation values as `${env.X}` (and the key must exist in `config/example.env`). Fixtures use `Example Org`,
   `example.com` and generated GUIDs.
   - The guard tests check committable **text** files for secrets and for your tenant's values — but only on your
     machine: the tenant values come from your env file, so the `pre-commit` hook is the only place they are checked
     (CI has no tenant configuration), and no guard reads images. Screenshots are your responsibility: mock mode only.
2. Secrets are never printed, logged, committed, put in run outputs (`secretOutputs`), or pasted into chat, issues or
   AI prompts. `pnpm adminforge env check` shows key **names and states** only — that's the only way to inspect a
   config file in front of others.
3. Real configuration lives in `~/.config/adminforge/` (directory 700, files 600 — the API and the CLI refuse an env
   file other users can read). Don't copy it elsewhere, don't put it in the repository, don't share it. Provisioner
   credentials (`*.admin.env`) are read only by `provision …`, `validate --scopes`, `env check` (key states only) and
   the live tests.
4. When you report on live work (a PR, a chat, a bug), report **counts and statuses**, not names, UPNs or ids.

**Identity and writes**

5. Interactive work is delegated: the Read app, and the Write app only while armed. Never add app-only permissions to
   an interactive path. The automation identity never acts **for a person**: it runs unattended work (the scheduler
   and scheduled runs) and the few platform tasks `SECURITY.md` lists (protected-object lookups, notification mail,
   checking a portal schedule's creator still has access).
6. Every write is declared by published content (`mode: write` steps with `describe`, `risk`, `confirm` or
   `approval`). Never add a generic write proxy, a "raw request" endpoint, or a way to run arbitrary Graph calls.
7. Every Microsoft call goes through the outbound executor (`ctx.outbound.execute(identity, call, { correlationId })`),
   which applies the default-deny request policy, picks the right token, carries the correlation id to Microsoft
   (`client-request-id`) and maps errors. Never `fetch` Microsoft directly. Writes that don't go through `execute`
   still call `ctx.outbound.assertWritable(...)` (emergency stop, protected objects). Content never sets the headers
   AdminForge owns (`Authorization`, `Cookie`, `Proxy-Authorization`, `Host`, the client-request-id headers):
   `validate` and the executor refuse them, and the HTTP client drops them.
8. Separation of duties: nobody approves their own request or a change that benefits them; AdminForge's own apps,
   the groups that grant portal roles and protected accounts are out of reach of writes; scheduled writes need two
   people. Don't add shortcuts around these, even for admins.

**Untrusted input and output**

9. Anything a person types, or that comes from Microsoft, is untrusted. In content use `$odata()` /
   `$odataSearch()` for Graph filters and searches, `$kql()` for KQL, `$encode()` for path segments, `$guid()` for
   ids; advanced filters are compiled on the server (`${ advanced }`), never read raw. Wrapping doesn't hide a value:
   `validate` follows user data through functions, variables and lambdas, and an encoder counts only in its own place
   (`$odata()` and `$kql()` outside your own quotes, `$odataSearch()` inside them). In a write, the segment after
   `/users/` is `$guid(…)` — a user named by sign-in name is refused (`user_not_by_id`), because protected accounts are
   matched by id. In code use the same helpers (`odataLiteral`, `odataSearchEscape`, `kqlLiteral`,
   `encodePathSegment` in `@adminforge/expressions`) and zod-parse every request body and query.
10. Text that leaves AdminForge (email, Teams, files) or is shown in the UI is data, never markup or code: no
    `dangerouslySetInnerHTML` with data, Markdown escaped, CSV formula characters neutralised. A link templated from
    data goes through `safeUrl` (`AppLink` and `useNavigateHref` in the web app; widgets check their own targets):
    `https:`, `http:`, `mailto:`, an in-app `/…` path (never `//host`) or `#anchor` — anything else shows as text.
11. Traffic that isn't to Microsoft's APIs has its own guarded path — reuse it, don't open a new one: Teams webhooks
    only on Microsoft webhook hosts, probe targets through `assertProbeTarget`, news feeds only from the
    `NEWS_FEED_HOSTS` allow-list (ADR-013). A new outbound host is a reviewed code change. In the cluster the pod
    may reach only public addresses on 443 (`portal/deploy/kubernetes/base/networkpolicy.yaml`); a private address
    an installation needs is an exception in its overlay's own policy, never in the base.

**The API surface**

12. Every `/api` route needs a session and `Portal.Reader`, except the five shell routes in `READER_EXEMPT`
    (`portal/apps/api/src/app.ts`, pinned by `tests/api/reader-required.test.ts`). Check further roles with
    `requireRole(...)` in the handler; roles are flat — none implies another.
13. CSRF: every non-GET `/api` request needs `X-AdminForge-CSRF` (enforced globally — don't exempt routes); the
    state-changing `/auth` POSTs use `requireSessionWithCsrf`; a GET that consumes state (reading a show-once secret)
    calls `assertCsrf` itself.
14. Every state change appends an audit event with the actor and identity. Security-relevant refusals are audited
    centrally (`request.denied`) for the codes in `AUDITED_DENIALS` (`errors.ts`) — add a new refusal code there if it
    matters for an investigation.
15. Errors never contain tokens, stack traces, header names, raw upstream bodies or another person's data.

**Monitoring, the browser and bulk changes**

16. Probe detail rows ("What it found"), report files and scheduled run outputs were collected with the automation
    identity's application permissions, so only Operators see them by default. A probe's **message** reaches every
    Reader: keep names, ids and rows out of it (an aggregate such as the most common error code is fine) and put them
    in the detail rows. A probe's `link` is an in-app path or an https URL (validation refuses `//host`); shipped
    probes link only to AdminForge or Microsoft hosts.
17. Browser code runs under `script-src 'self'` with no `unsafe-eval`: no `eval`, `new Function`, inline scripts or
    libraries that need them ([web guide](07-web-guide.md#under-the-security-policy)). Don't loosen the policy to make
    a library work — pick another library.
18. A playbook that acts on a target whose id can be reused or change hands (an AVD session number, a list minutes
    old) passes what the person saw and `assert`s it still holds before writing. High-risk changes use a typed
    confirmation (in bulk: the number of items), and a bulk run's audit event keeps the inputs the items share — the
    reason — redacted like a single run's.

## What needs a security review

Ask for one — run the `security-reviewer` agent **and** get a code owner's review — when the change touches:

- `portal/apps/**` or `portal/packages/{connectors,engine,expressions}` (the agent's own scope), and in particular
  `portal/apps/api/src/{auth,security,execution}/`, the request policy, the runner, the scheduler, provisioning
  (`portal/tools/cli/src/provision`) and `portal/deploy`;
- content that writes, runs unattended, or calls out: `playbooks/`, `runbooks/`, `schedules/`, `probes/`,
  `connections/`, `scripts/`, `feeds/` and the news host list;
- anything that adds a permission, a configuration key holding a secret, a new outbound host, a new way to send
  data out (email, webhook, file), or a new role check;
- a new web dependency, or anything that changes the security headers or what a probe message or link may contain;
- `.github/`, `.githooks/`, `tooling/` and `.claude/` (they decide what runs on every change).

For content changes, also run the `content-reviewer` agent. `.github/CODEOWNERS` lists these paths, so GitHub
requests a code owner's review on them — once branch protection with "Require review from Code Owners" is on.
Today one person owns every path, and nobody can approve their own pull request: until more owners are added,
a code owner's own changes need another engineer's review by agreement (a known gap in `SECURITY.md`). The
[checklists](checklists.md#security-review) have the reviewer's questions.

## Dependencies

- Prefer the platform and the packages already in the workspace. A new dependency needs a sentence in the PR on why,
  its maintenance and licence, and what it can reach (network, filesystem, `eval`, install scripts).
- npm dependencies use `^` ranges; the committed `pnpm-lock.yaml` and `pnpm install --frozen-lockfile` (CI) make
  installs reproducible. Install scripts are opt-in (`allowBuilds` in `pnpm-workspace.yaml`), and security fixes for
  transitive packages go in its `overrides`. Exact pins are used for PowerShell modules
  (`portal/apps/runner/modules.lock.json`), GitHub Actions (a commit SHA with the version in a comment) and both
  images' base images (by digest, `tests/guards/image-digests.test.ts`).
- **New versions wait seven days.** pnpm resolves only versions published at least seven days ago and re-checks the
  lockfile against that on every install (`minimumReleaseAge` in `pnpm-workspace.yaml`, strict); Dependabot waits the
  same (`cooldown`). An urgent fix that can't wait — a Dependabot security update skips its cooldown but not pnpm's
  floor — goes in `minimumReleaseAgeExclude` as one exact `name@x.y.z` with a comment saying why and when it comes
  out, in the same pull request; remove it once the version has aged. Never a bare package name or a pattern.
- CI fails on high or critical advisories (`pnpm audit --audit-level high`); Dependabot proposes updates weekly.
- Test-only dependencies belong to `@adminforge/tests`, never to a runtime package.

## Live tenants

- You test against the **validation tenant**, never production, and only after a code owner gave you access.
- Writes only on the `AF-Test-*` objects provisioning created (`pnpm adminforge provision test-identities`): dry run →
  run → compensating playbook → check `/audit` ([`tests/live/README.md`](../../tests/live/README.md)).
- Live-test output and screenshots stay outside the repository (`AF_LIVE_OUT`).
- Don't run `adminforge provision entra`, `publish` to a shared database, or anything against the cluster unless a
  code owner asked you to ([Releases and operations](13-releases-and-operations.md)).
- Don't paste tenant output into AI tools, issues or chats. Summaries with counts and statuses are fine.

## If you find a vulnerability or leak

- In AdminForge itself: open a **private** security advisory on the repository (Security → Advisories) or contact the
  repository owner directly. Never a public issue, PR title or channel.
- A secret or tenant value got committed or pushed: tell a code owner immediately. Rotating the secret comes first
  (`docs/operations.md` → Secret and key rotation); rewriting history alone doesn't help once it was pushed.
- A playbook did something unexpected in a tenant: an Approver or Admin can pause all changes or all automation from
  **Admin → Settings → Emergency stop**; then tell a code owner with the run's reference.

## Read next

[Coding standards](05-coding-standards.md).
