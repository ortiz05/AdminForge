import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDefinition, type Connection } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';
import { brief, ENVELOPE, errors, ok } from './helpers';

// S-23: a `mode: read` operation that POSTs must say `readPost: true` — the reviewed statement that the POST only
// reads (a search or query that takes its filter as a body). Without it validate refuses the connection, so no read
// session ever sends it.
const conn = (ops: string) =>
  `${ENVELOPE('connection', 'integrations.example')}baseUrl: https://func.example.com\naudience: api://example\noperations:\n${ops}`;

describe('connection operations: readPost (S-23)', () => {
  it('a read-mode POST with readPost: true is accepted', () => {
    const def = ok<Connection>(
      conn('  search: { method: POST, path: /api/search, mode: read, readPost: true }\n'),
    );
    expect(def.operations.search).toMatchObject({ method: 'POST', mode: 'read', readPost: true });
  });

  it('a read-mode POST without it is refused, naming the field', () => {
    const e = errors(conn('  search: { method: POST, path: /api/search, mode: read }\n'));
    expect(brief(e)).toEqual(['operations.search.readPost@9']);
    expect(e[0]!.message).toMatch(/readPost: true/);
  });

  it.each([
    [
      'a GET',
      '  list: { method: GET, path: /api/list, mode: read, readPost: true }\n',
      'operations.list.readPost@9',
    ],
    [
      'a write',
      '  sync: { method: POST, path: /api/sync, mode: write, readPost: true }\n',
      'operations.sync.readPost@9',
    ],
  ])('readPost on %s is refused (it only describes read-mode POSTs)', (_l, ops, at) =>
    expect(brief(errors(conn(ops)))).toEqual([at]),
  );

  it('a write-mode POST needs no readPost', () =>
    expect(ok(conn('  sync: { method: POST, path: /api/sync, mode: write }\n'))).toBeTruthy());

  it('the shipped connections validate', () => {
    const file = path.join(repoRoot, 'portal/content/connections/hr-sync.connection.yaml');
    const r = parseDefinition(readFileSync(file, 'utf8'), file);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});
