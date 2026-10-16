import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

/** The BFF owns /api and /auth; in development Vite forwards them so cookies stay same-origin. */
const api = `http://localhost:${process.env.API_PORT ?? 3001}`;

/**
 * Production source maps stay on the build machine. `sourcemap: 'hidden'` leaves the `sourceMappingURL` comment out
 * of the served JavaScript, and this moves the `.map` files out of dist/ — which the API serves to anyone, signed in
 * or not — into sourcemaps/ next to it (git-ignored), for decoding a stack trace locally.
 */
function sourcemapsOutsideDist(): Plugin {
  let outDir = '';
  let mapsDir = '';
  return {
    name: 'adminforge:sourcemaps-outside-dist',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      mapsDir = path.resolve(config.root, 'sourcemaps');
    },
    buildStart() {
      rmSync(mapsDir, { recursive: true, force: true });
    },
    writeBundle() {
      mkdirSync(mapsDir, { recursive: true });
      writeFileSync(path.join(mapsDir, '.gitignore'), '*\n');
      for (const rel of readdirSync(outDir, { recursive: true, encoding: 'utf8' })) {
        if (!rel.endsWith('.map')) continue;
        const to = path.join(mapsDir, rel);
        mkdirSync(path.dirname(to), { recursive: true });
        renameSync(path.join(outDir, rel), to);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    sourcemapsOutsideDist(),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/auth': api },
  },
  preview: { port: 4173 },
  build: {
    // Generated for local debugging, never served (see sourcemapsOutsideDist).
    sourcemap: 'hidden',
    rolldownOptions: {
      // Contract modules are pure definitions; let the bundler drop the ones the browser never uses
      // (content parsing, YAML) instead of shipping them in the first load.
      treeshake: {
        moduleSideEffects: [{ test: /[\\/]packages[\\/]schemas[\\/]src[\\/]/, sideEffects: false }],
      },
    },
  },
});
