# `@adminforge/config`

Where AdminForge's configuration lives and which of it counts as tenant data. Used by the API, the scheduler, the
`adminforge` CLI and the tests; it depends on Node built-ins only.

| Module                 | What                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`         | The layered env files outside the repository (`envFilePath`, `envFiles`, `loadEnv`): `<env>.env`, then `<env>.admin.env` for admin tooling only, then the `ADMINFORGE_ENV_OVERLAY` file; the process environment wins. `parseEnv`, `writeEnvKeys` (admin keys go to the admin file), `repoRoot`. |
| `src/tenant-values.ts` | `tenantValues` / `isPublicCatalogueValue`: which configuration values count as tenant data — the one rule shared by the no-tenant-data guard (`tests/guards/no-tenant-data.test.ts`) and `adminforge fixtures record`. Dependency-free.                                                          |

Conventions: real values never enter the repository (CLAUDE.md non-negotiable 1) — every key is documented in
`config/example.env`. Tests: `tests/unit/config/` (env layers) and `tests/guards/tenant-values.test.ts`.
