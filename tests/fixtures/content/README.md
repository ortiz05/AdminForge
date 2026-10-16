# Synthetic content trees for tests

Self-contained content (definitions) plus the connector fixtures that answer it, for tests that must not depend on
`portal/content` (which other work keeps changing). Not read by `DATA_MODE=fixtures` from `tests/fixtures/` — no
service is called `content` — only by the test helper that copies a set into a temporary directory.

| Set         | Loaded by                     | Contents                                                                                                    |
| ----------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `platform/` | `tests/api/content-helpers.ts` | `content/`: navigation, identity/security pages, the `deps.*` dependency pages, a report, a playbook. `responses/`: their Graph, ARM, Resource Graph and runner fixtures (same naming scheme as `tests/fixtures/<service>/`) |

Synthetic only (`Example Org`, `example.com`, generated GUIDs). Like the rest of `tests/fixtures/`, these files are
hand-laid-out data and not formatted by Prettier.
