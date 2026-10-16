# Contributing to AdminForge

Start with the **[engineer onboarding guide](docs/onboarding/README.md)** — setup, how AdminForge works, where things
go, and how we write code, APIs, content, tests, docs and commits. The essentials:

- **Nothing tenant-specific or secret in git** — ever, anywhere. Guards enforce it; never use `--no-verify`.
- **Content first**: pages, reports, playbooks, schedules and probes are YAML in `portal/content`.
- **One change ships complete**: code or content + tests + fixtures + docs + `CHANGELOG.md`.
- **Commit messages and PR titles** are Conventional Commits with our types and scopes
  (`feat(reports): schedule a report from the catalogue`) — commit messages are checked by `.githooks/commit-msg`, PR
  titles by the `pr-title` workflow ([guide](docs/onboarding/10-git-and-pull-requests.md)).
- **Every change is reviewed** by someone other than the author; security-sensitive paths by a code owner
  (`.github/CODEOWNERS`).

The rules themselves live in [`CLAUDE.md`](CLAUDE.md) and [`SECURITY.md`](SECURITY.md). Found a vulnerability? Open a
private security advisory on the GitHub repository (Security → Advisories), or contact the repository owner directly.
Don't file a public issue.
