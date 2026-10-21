import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../lib/repo';
import { entraConfig, FakeAuthClient, makeApp, mockConfig } from './helpers';

// docs/api.md's endpoint index is the contract people read; it drifted (66 routes said, 70 registered, a route
// missing). This builds the real app in both sign-in modes and holds the index and its count sentence to what Fastify
// actually registers. HEAD (added by Fastify for every GET) is not listed in the index.

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * "METHOD /path" for every route of `printRoutes({ commonPrefix: false })`: a tree where each line is a path segment
 * (`├── /segment (GET, HEAD)`), indented four characters per level; a route's path is its ancestors' segments joined.
 */
function routesFromTree(tree: string): string[] {
  const stack: string[] = [];
  const out: string[] = [];
  for (const line of tree.split('\n')) {
    const m = /^((?:[│ ] {3})*)[├└]── (.+?)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    const methods = (m[3] ?? '').split(', ').filter((x) => (METHODS as readonly string[]).includes(x));
    for (const method of methods) out.push(`${method} ${stack.join('')}`);
  }
  return out;
}

async function registered(mode: 'mock' | 'entra'): Promise<string[]> {
  const t =
    mode === 'mock'
      ? await makeApp(mockConfig())
      : await makeApp(entraConfig(), { auth: new FakeAuthClient() });
  try {
    await t.app.ready();
    return routesFromTree(t.app.printRoutes({ commonPrefix: false }));
  } finally {
    await t.app.close();
  }
}

const apiDoc = readFileSync(path.join(repoRoot, 'docs', 'api.md'), 'utf8');
const indexSection = apiDoc.slice(apiDoc.indexOf('## Endpoint index'), apiDoc.indexOf('## Session & auth'));
const documented = [...indexSection.matchAll(/^\| `([A-Z]+)` +\| `([^`]+)` +\|/gm)].map(
  (m) => `${m[1]} ${m[2]}`,
);

describe('docs/api.md endpoint index', () => {
  let mock: string[];
  let entra: string[];
  let all: string[];

  beforeAll(async () => {
    mock = await registered('mock');
    entra = await registered('entra');
    all = [...new Set([...mock, ...entra])].sort();
  });

  it('reads the tree Fastify prints', () => {
    expect(
      routesFromTree(
        [
          '├── /auth/arm (POST)',
          '│   ├── /extend (POST)',
          '│   └── /callback (GET, HEAD)',
          '└── /api/schedules/:key (GET, HEAD, PATCH)',
          '    └── /run (POST)',
          '        └── s (GET, HEAD)',
        ].join('\n'),
      ),
    ).toEqual([
      'POST /auth/arm',
      'POST /auth/arm/extend',
      'GET /auth/arm/callback',
      'GET /api/schedules/:key',
      'PATCH /api/schedules/:key',
      'POST /api/schedules/:key/run',
      'GET /api/schedules/:key/runs',
    ]);
  });

  it('builds both apps with routes to compare', () => {
    expect(mock.length).toBeGreaterThan(50);
    expect(entra.length).toBeGreaterThan(50);
    expect(mock).toContain('POST /auth/mock/state');
    expect(entra).toContain('GET /auth/callback');
  });

  it('lists every registered route (mock and Entra sign-in)', () => {
    expect(all.filter((r) => !documented.includes(r))).toEqual([]);
  });

  it('lists no route the app does not register', () => {
    expect(documented.filter((r) => !all.includes(r))).toEqual([]);
  });

  it('lists each route once', () => {
    expect(documented.filter((r, i) => documented.indexOf(r) !== i)).toEqual([]);
  });

  it('counts them right', () => {
    const m = /\*\*(\d+) routes\*\*: (\d+) health, (\d+) auth\b[\s\S]*?, and (\d+) under `\/api`/.exec(
      indexSection,
    );
    expect(m, 'the count sentence: "**N routes**: N health, N auth (…), and N under `/api`"').not.toBeNull();
    const [total, health, auth, api] = m!.slice(1).map(Number);
    const startsWith = (p: string) => all.filter((r) => r.split(' ')[1]!.startsWith(p)).length;
    expect({ total, health, auth, api }).toEqual({
      total: all.length,
      health: all.length - startsWith('/auth/') - startsWith('/api/'),
      auth: startsWith('/auth/'),
      api: startsWith('/api/'),
    });
  });
});
