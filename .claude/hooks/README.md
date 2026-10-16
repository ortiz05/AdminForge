# Claude Code hooks

Wired in `.claude/settings.json`. They give Claude Code the feedback CI would give, right after it writes a file.

| Hook             | Event                          | Does                                                                                                                                                                                     |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `after-edit.mjs` | `PostToolUse` on `Write\|Edit` | Prettier on code and docs; `adminforge validate` after a content definition or runner script changes (schema, references, lint, stale script sha256 pins); design-token check on UI code |

`after-edit.mjs` reads the tool call as JSON on stdin and exits 2 with the problems on stderr (Claude sees them and
fixes them) or 0. Its decisions (`editedFile`, `checksFor`, `runChecks`, `validateFeedback`) are exported pure
functions with the commands injected, tested in `tests/unit/tooling/after-edit-hook.test.ts`; the design-token
patterns come from `tooling/lint/design-token-patterns.mjs`, shared with ESLint and the guard test.

Conventions: a hook mirrors an existing rule (CI, a guard, the CLI) rather than inventing one; it is best effort — its
own failures (no pnpm, a timeout) never block; it never prints secrets or file contents beyond the offending line
numbers.
