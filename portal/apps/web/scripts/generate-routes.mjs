// Writes src/routeTree.gen.ts (git-ignored) without starting a server: resolving the Vite config runs
// the TanStack Router generator. Used by `typecheck` and by the test setup on a fresh checkout.
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';

await resolveConfig({ root: fileURLToPath(new URL('..', import.meta.url)), logLevel: 'warn' }, 'build');
