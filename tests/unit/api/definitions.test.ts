import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  clientDefinition,
  compareSemVer,
  FsDefinitionSource,
  notifyPayload,
  registryFrom,
  type DefinitionsChanged,
} from '@adminforge/api/src/definitions';
import type { Connection, Definition } from '@adminforge/schemas';

const page = (id: string, version = '1.0.0', extra = '') => `kind: page
id: ${id}
version: ${version}
title: ${id}
owner: test-team
template: list-detail
${extra}datasources:
  rows:
    source: static
    data: [1, 2]
layout:
  - widget: kpi
    data: rows
`;

function contentDir(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-content-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('FsDefinitionSource + DefinitionResolver', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists and resolves; retired definitions resolve only by exact version', async () => {
    dir = contentDir({
      'pages/a/one.page.yaml': page('a.one'),
      'pages/a/old.page.yaml': page('a.old', '2.0.0', 'status: retired\n'),
    });
    const reg = registryFrom(new FsDefinitionSource(dir), 'fs');
    expect((await reg.list('page')).map((r) => r.key)).toEqual(['a.one']);
    const r = await reg.resolve('page', 'a.one');
    expect(r).toMatchObject({ version: '1.0.0', def: { id: 'a.one', kind: 'page' } });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(reg.resolve('page', 'a.old')).rejects.toMatchObject({
      status: 404,
      code: 'definition_not_found',
    });
    expect((await reg.resolve('page', 'a.old', '2.0.0')).version).toBe('2.0.0');
    await expect(reg.resolve('page', 'a.one', '9.9.9')).rejects.toMatchObject({
      code: 'definition_not_found',
    });
    expect(await reg.resolveAny(['page', 'dashboard', 'report'], 'a.one')).toMatchObject({
      kind: 'page',
      version: '1.0.0',
    });
    await reg.close();
  });

  it('reload reports changed keys and keeps the last good version of a file that stops validating', async () => {
    dir = contentDir({ 'pages/a/one.page.yaml': page('a.one'), 'pages/a/two.page.yaml': page('a.two') });
    const src = new FsDefinitionSource(dir);
    const changes: DefinitionsChanged[] = [];
    src.onChange((c) => changes.push(c));
    expect((await src.list()).length).toBe(2);
    writeFileSync(path.join(dir, 'pages/a/one.page.yaml'), page('a.one', '1.1.0'));
    writeFileSync(path.join(dir, 'pages/a/two.page.yaml'), 'kind: page\nid: a.two\nversion: nope\n');
    const change = await src.reload();
    expect(change).toEqual({ keys: ['page:a.one'] });
    expect(changes).toEqual([{ keys: ['page:a.one'] }]);
    expect((await src.get('page', 'a.one'))!.version).toBe('1.1.0');
    expect((await src.get('page', 'a.two'))!.version).toBe('1.0.0');
    expect(src.problems().some((p) => p.file === 'pages/a/two.page.yaml')).toBe(true);
    rmSync(path.join(dir, 'pages/a/one.page.yaml'));
    expect(await src.reload()).toEqual({ keys: ['page:a.one'] });
    expect(await src.get('page', 'a.one')).toBeNull();
    await src.close();
  });

  it('watches the directory and reloads on change (hot reload)', async () => {
    dir = contentDir({ 'pages/a/one.page.yaml': page('a.one') });
    const src = new FsDefinitionSource(dir, { watch: true, debounceMs: 30 });
    const changes: DefinitionsChanged[] = [];
    src.onChange((c) => changes.push(c));
    await src.list();
    writeFileSync(path.join(dir, 'pages/a/one.page.yaml'), page('a.one', '1.0.1'));
    await waitFor(() => changes.length > 0);
    expect(changes[0]).toEqual({ keys: ['page:a.one'] });
    expect((await src.get('page', 'a.one'))!.version).toBe('1.0.1');
    await src.close();
  });

  it('compareSemVer', () => {
    expect(
      ['1.10.0', '1.2.0', '1.2.0-beta.2', '1.2.0-beta.10', '0.9.9', '1.2.0-alpha'].sort(compareSemVer),
    ).toEqual(['0.9.9', '1.2.0-alpha', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0', '1.10.0']);
    expect(compareSemVer('1.0.0+build.1', '1.0.0')).toBe(0);
  });

  it('the client copy keeps layout/datasources but drops $schema, connection endpoints and webhook references', () => {
    const conn = {
      kind: 'connection',
      $schema: '../x.json',
      id: 'x.api',
      version: '1.0.0',
      title: 'API',
      owner: 't',
      baseUrl: 'https://api.example.com',
      audience: 'api://example',
      scopes: ['api://example/read'],
      operations: { get: { method: 'GET', path: '/x', mode: 'read' } },
    } as unknown as Connection;
    const out = clientDefinition(conn);
    expect(out).not.toHaveProperty('$schema');
    expect(out).not.toHaveProperty('baseUrl');
    expect(out).not.toHaveProperty('audience');
    expect(out.operations).toEqual({ get: { method: 'GET', path: '/x', mode: 'read' } });
    const sched = clientDefinition({
      kind: 'schedule',
      id: 's.x',
      notify: { onFailure: [{ type: 'teams', webhook: '${ env.AF_HOOK }' }] },
    } as unknown as Definition);
    expect(JSON.stringify(sched)).not.toContain('webhook');
  });

  it('NOTIFY payloads fall back to {all:true} when too large', () => {
    expect(JSON.parse(notifyPayload(['page:a.b']))).toEqual({ keys: ['page:a.b'] });
    expect(
      JSON.parse(notifyPayload(Array.from({ length: 2000 }, (_, i) => `page:section.page-${i}`))),
    ).toEqual({ all: true });
  });
});
