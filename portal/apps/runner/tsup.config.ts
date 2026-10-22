import { defineConfig } from 'tsup';

// The runner image ships one self-contained bundle (no node_modules): every dependency is bundled in.
// esbuild's ESM output needs a real `require` for the CommonJS dependencies (fastify, pino).
export default defineConfig({
  entry: { main: 'src/main.ts', healthcheck: 'src/healthcheck.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24', // the runner image's Node (portal/apps/runner/Dockerfile): it moves with that image
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __afCreateRequire } from 'node:module'; const require = __afCreateRequire(import.meta.url);",
  },
});
