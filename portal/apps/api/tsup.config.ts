import { defineConfig } from 'tsup';

// Production bundle: workspace packages (@adminforge/*, shipped as TypeScript source) are bundled in;
// npm dependencies stay external and are installed next to dist/.
export default defineConfig({
  entry: {
    main: 'src/main.ts',
    migrate: 'src/db/migrate.ts',
    'init-local': 'src/scripts/init-local.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@adminforge\//],
});
