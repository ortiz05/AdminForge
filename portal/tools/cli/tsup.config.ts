import { defineConfig } from 'tsup';

// The CLI for the container image (`adminforge` in the pod: publish, audit verify, db backup / import-postgres): one
// bundle with the workspace packages it reuses (@adminforge/*, shipped as TypeScript source — including the API's
// tooling barrel) and their npm dependencies; this package's own dependencies stay external (better-sqlite3 is native).
// In a checkout the CLI runs from source (`pnpm adminforge`, tsx). Bundled CommonJS modules need a real `require`.
export default defineConfig({
  entry: { adminforge: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node26',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@adminforge\//],
  banner: {
    js: "import { createRequire as __afCreateRequire } from 'node:module'; const require = __afCreateRequire(import.meta.url);",
  },
});
