// The web app's route tree is generated (git-ignored). Make sure it exists before importing the router.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function findWeb(from: string): string {
  for (let dir = from; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'portal/apps/web');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('portal/apps/web not found above the test working directory');
}

const web = findWeb(process.cwd());
if (!existsSync(path.join(web, 'src/routeTree.gen.ts'))) {
  execFileSync(process.execPath, ['scripts/generate-routes.mjs'], { cwd: web, stdio: 'inherit' });
}
