# Engineer onboarding

Everything an engineer needs to contribute to AdminForge the same way as everyone else: the same commits, code, folder
layout, API shape, documentation and security habits. Read it in order on your first days; come back to the
checklists every time you open a pull request.

AdminForge is an admin portal for Microsoft Entra ID, Microsoft 365, Intune, Defender and Azure. Engineers sign in with
their own identity and work through **delegated** permissions; most features are **declarative content** (YAML)
rendered and executed by a generic engine. It manages real tenants, so the way we build it is part of its security.

**Day one:** in Claude Code at the repository root, say **onboard** (or run `node tooling/onboard.mjs`) — it sets
your checkout up and checks the tools, git hooks, Claude Code hooks, skills and agents ([guide 1](01-setup.md)).

## Reading path

| #   | Guide                                                                           | What you'll know afterwards                                                          | Time   |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------ |
| 1   | [Set up your machine](01-setup.md)                                              | AdminForge running locally on synthetic data, tests green, hooks installed           | 1–2 h  |
| 2   | [How AdminForge works](02-how-adminforge-works.md)                              | The processes, the three identities, what happens on a read, a write and a schedule  | 45 min |
| 3   | [Repository map](03-repository-map.md)                                          | Where everything lives, where a new thing goes, how files and ids are named          | 30 min |
| 4   | [Security for contributors](04-security.md)                                     | The rules that are never traded for convenience, and what needs a security review    | 45 min |
| 5   | [Coding standards](05-coding-standards.md)                                      | TypeScript, errors, comments, naming, dependencies — the house style                 | 45 min |
| 6   | [API guide](06-api-guide.md)                                                    | How a route, service, store, contract, error, audit event and migration fit together | 1 h    |
| 7   | [Web guide](07-web-guide.md)                                                    | How pages, data fetching, design tokens, accessibility and copy work in the SPA      | 45 min |
| 8   | [Content guide](08-content-guide.md)                                            | Pages, reports, playbooks, schedules and probes as YAML; validate, test, publish     | 1 h    |
| 9   | [Testing](09-testing.md)                                                        | Which test project to use, fixtures, mock e2e and screenshots, live validation       | 45 min |
| 10  | [Git and pull requests](10-git-and-pull-requests.md)                            | Branches, the commit message format (enforced), PR size, review and merge            | 30 min |
| 11  | [Documentation](11-documentation.md)                                            | Which docs each kind of change must update, and how we write them                    | 30 min |
| 12  | [Working with Claude Code](12-claude-code.md)                                   | The skills, reviewer agents and hooks that keep changes consistent                   | 30 min |
| 13  | [Releases and operations](13-releases-and-operations.md)                        | How a merged change reaches the cluster, and what contributors never do there        | 20 min |
| —   | [Checklists](checklists.md) · [Glossary](glossary.md) · [Templates](templates/) | First day/week, PR author and reviewer, definition of done; the vocabulary           |        |

## The short version

If you remember nothing else, remember these. Each links to the guide that explains it.

1. **Nothing tenant-specific in git** — no tenant, client, subscription or workspace ids, domains, UPNs, names or
   secrets, in code, fixtures, docs, screenshots, commit messages or PR descriptions. Real values live only in
   `~/.config/adminforge/<env>.env`. The pre-commit hook checks your tenant's values against every commit — it's the
   only check that knows them, so never use `--no-verify`. ([Security](04-security.md))
2. **Delegated by default, writes only through published content.** No generic write proxy, no app-only permissions
   on interactive paths; every write is a `mode: write` step in a reviewed playbook.
   ([How it works](02-how-adminforge-works.md))
3. **Content first.** A new page, report, playbook, schedule or probe is YAML in `portal/content`. Extend the renderer
   or engine only generically, never for one page. ([Content](08-content-guide.md))
4. **Contracts first for the API.** Request and response schemas in `portal/packages/schemas`, thin routes, logic in
   services, an audit event for every state change, `docs/api.md` updated. ([API](06-api-guide.md))
5. **Errors are for the person in front of the browser:** `message` says what happened, `hint` what to do, every error
   carries a reference. ([Coding standards](05-coding-standards.md))
6. **Design tokens only** in UI code; ember means write mode and nothing else. ([Web](07-web-guide.md))
7. **Tests live under `tests/`**, mirror what they test, and are new files rather than additions to shared suites.
   ([Testing](09-testing.md))
8. **One change ships complete:** code or content + tests + fixtures + docs + changelog, in one pull request.
   ([Documentation](11-documentation.md))
9. **Commit messages are Conventional Commits** with our types and scopes; the `commit-msg` hook checks commits and
   the `pr-title` workflow checks pull request titles. ([Git](10-git-and-pull-requests.md))
10. **Security-relevant changes get a security review** before merge: the `security-reviewer` agent plus a code
    owner's (or, for a code owner's own change, a second engineer's) review. ([Security](04-security.md))
11. **Checks explain themselves:** every probe has a `group`, a `remedy` and a `link`; the rows behind a result are
    Operator-only and never go into its message. ([Content](08-content-guide.md))
12. **Fixtures can't catch what Microsoft rejects.** `validate` knows some limits (Resource Graph's joins); run every
    new query once live, read-only, or record it as unchecked. ([Content](08-content-guide.md))
13. **No `eval` in the browser** — the security policy forbids it, for libraries too. ([Web](07-web-guide.md))

## Where the rules come from

These guides explain and connect the sources of truth: [`CLAUDE.md`](../../CLAUDE.md) for the non-negotiables and
commands, [`SECURITY.md`](../../SECURITY.md) for the security model, and the reference documents the
[documentation index](../README.md) lists with what each owns. When a guide and its source disagree, the source wins
and the guide is the bug.

## Getting help

- Ask in the team channel, and say what you tried. Paste error **references** (correlation ids) and codes, not
  screenshots of tenant data.
- Security concerns go to the code owners privately, never to an issue or a public channel ([Security](04-security.md)).
- If a guide is wrong or missing something, fix it in the same pull request that taught you — that is how this folder
  stays true.
