import { defineConfig } from 'tsup';

// One bundle: workspace packages (@adminforge/*, shipped as TypeScript source — including the API modules the scheduler
// reuses) and their npm dependencies are bundled in; this package's own dependencies (better-sqlite3, drizzle-orm,
// croner, @azure/msal-node, zod) stay external. Bundled CommonJS modules need a real `require` in ESM output.
export default defineConfig({
  entry: { main: 'src/main.ts' },
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
