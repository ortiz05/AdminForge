import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

/** The BFF owns /api and /auth; in development Vite forwards them so cookies stay same-origin. */
const api = `http://localhost:${process.env.API_PORT ?? 3001}`;

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/auth': api },
  },
  preview: { port: 4173 },
  build: {
    sourcemap: true,
    rolldownOptions: {
      // Contract modules are pure definitions; let the bundler drop the ones the browser never uses
      // (content parsing, YAML) instead of shipping them in the first load.
      treeshake: {
        moduleSideEffects: [{ test: /[\\/]packages[\\/]schemas[\\/]src[\\/]/, sideEffects: false }],
      },
    },
  },
});
