# CLI tests (`@adminforge/cli`)

Unit tests for `portal/tools/cli` (vitest project `unit`). Run them with:

```bash
pnpm --filter @adminforge/tests exec vitest run --project unit unit/cli
```

- One file per behaviour, named after what it covers (`publish-review`, `script-pins`, `unexpected-privilege`, …).
  Add a new file rather than growing `content.test.ts`.
- Provisioning commands run end to end against in-memory fakes: `fake-cloud.ts` (Entra token endpoint, Graph, ARM)
  and `azure-test-fake.ts` (adds Log Analytics). Pure planners are tested directly.
- Content commands run against temporary content directories, with the store, engine, git state, audit writer and
  fetch injected through `ContentCliContext`.
- Env-file tests write temporary files and point `ADMINFORGE_ENV_FILE` at them — never at `~/.config/adminforge`.
- Data is synthetic (`example.com`, generated GUIDs). Nothing reaches the network, a tenant or a shared database.

The command reference and module layout are in `portal/tools/cli/README.md`.
