# Git hooks

`pnpm install` points git at this folder (`git config core.hooksPath .githooks`, the root `prepare` script). Never
bypass them with `--no-verify`; fix what they report instead.

| Hook         | Runs                                         | Blocks                                                                  |
| ------------ | -------------------------------------------- | ----------------------------------------------------------------------- |
| `pre-commit` | `pnpm guard` (the guard tests, as in CI)     | Secrets, tenant-specific values, raw colours / arbitrary Tailwind in UI |
| `commit-msg` | `node tooling/git/commit-message.mjs <file>` | Messages that aren't Conventional Commits with our types and scopes     |

Hooks are POSIX `sh` scripts with a header comment and stay thin: the logic lives in a tested tool (`tests/guards/`,
`tooling/git/`) that CI runs too. See `tooling/README.md`.
