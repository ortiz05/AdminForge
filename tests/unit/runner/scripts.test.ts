import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerPool } from '@adminforge/runner/src/pool';
import { ScriptError, resolveScript } from '@adminforge/runner/src/scripts';
import { buildRunnerServer } from '@adminforge/runner/src/server';
import {
  fakeWorkerCommand,
  job,
  makeScriptsDir,
  newKey,
  parseEvents,
  sha256,
  signedInject,
  testConfig,
} from './helpers';

describe('resolveScript', () => {
  const scripts = makeScriptsDir("Write-AdminForgeLog 'hi'\n");
  const outside = mkdtempSync(path.join(tmpdir(), 'af-outside-'));
  writeFileSync(path.join(outside, 'Evil.ps1'), 'Remove-Item -Recurse /');
  symlinkSync(path.join(outside, 'Evil.ps1'), path.join(scripts.dir, 'Linked.ps1'));
  symlinkSync(outside, path.join(scripts.dir, 'linkeddir'));
  afterAll(() => {
    scripts.cleanup();
    rmSync(outside, { recursive: true, force: true });
  });

  const expectError = async (p: Promise<unknown>, code: string, status: number) => {
    const error = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ScriptError);
    expect(error).toMatchObject({ code, statusCode: status });
  };

  it('returns the hashed content of a pinned script', async () => {
    const resolved = await resolveScript(scripts.dir, scripts.script, scripts.sha);
    expect(resolved).toMatchObject({
      path: 'diagnostics/Test.ps1',
      sha256: scripts.sha,
      content: "Write-AdminForgeLog 'hi'\n",
    });
  });

  it('hashes the raw bytes but hands over the text without a BOM', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Write-AdminForgeLog bom\n')]);
    writeFileSync(path.join(scripts.dir, 'diagnostics', 'Bom.ps1'), bytes);
    const resolved = await resolveScript(scripts.dir, 'diagnostics/Bom.ps1', sha256(bytes));
    expect(resolved.content).toBe('Write-AdminForgeLog bom\n');
  });

  it('refuses a script whose sha256 does not match (409)', async () => {
    await expectError(
      resolveScript(scripts.dir, scripts.script, sha256('something else')),
      'script_hash_mismatch',
      409,
    );
  });

  it('refuses a missing script (404)', async () => {
    await expectError(
      resolveScript(scripts.dir, 'diagnostics/Missing.ps1', scripts.sha),
      'script_not_found',
      404,
    );
  });

  it.each([
    '../Evil.ps1',
    '/etc/Evil.ps1',
    'diagnostics/../Test.ps1',
    'diagnostics\\Test.ps1',
    'diagnostics/Test.sh',
    './diagnostics/Test.ps1',
    'diagnostics//Test.ps1',
    '',
  ])('refuses the path %j (400)', async (p) => {
    await expectError(resolveScript(scripts.dir, p, scripts.sha), 'invalid_script_path', 400);
  });

  it('refuses symlinks that escape the scripts directory (400)', async () => {
    await expectError(
      resolveScript(scripts.dir, 'Linked.ps1', sha256('Remove-Item -Recurse /')),
      'invalid_script_path',
      400,
    );
    await expectError(
      resolveScript(scripts.dir, 'linkeddir/Evil.ps1', sha256('Remove-Item -Recurse /')),
      'invalid_script_path',
      400,
    );
  });
});

describe('POST /v1/jobs script checks', () => {
  const key = newKey();
  const scripts = makeScriptsDir();
  let app: Awaited<ReturnType<typeof buildRunnerServer>>;

  beforeAll(async () => {
    const pool = new WorkerPool({ command: fakeWorkerCommand(), size: 1, maxJobs: 2 });
    app = await buildRunnerServer({
      config: testConfig(key, { scriptsDir: scripts.dir }),
      pool,
      logger: false,
    });
  });
  afterAll(async () => {
    await app.close();
    scripts.cleanup();
  });

  it('answers 409 when the sha256 does not match', async () => {
    const res = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: job({ script: { path: scripts.script, sha256: sha256('x') } }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'script_hash_mismatch' });
  });

  it('answers 404 for a missing script and 400 for a path outside the directory', async () => {
    const missing = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: job({ script: { path: 'nope/Missing.ps1', sha256: scripts.sha } }),
    });
    expect(missing.statusCode).toBe(404);
    const escape = await signedInject(app, key, {
      method: 'POST',
      url: '/v1/jobs',
      body: job({ script: { path: '../etc/x.ps1', sha256: scripts.sha } }),
    });
    expect(escape.statusCode).toBe(400);
  });

  it('runs a script whose hash matches, and refuses the same job id again (replay)', async () => {
    const body = job({ script: { path: scripts.script, sha256: scripts.sha } });
    const res = await signedInject(app, key, { method: 'POST', url: '/v1/jobs', body });
    expect(res.statusCode).toBe(200);
    expect(parseEvents(res.body).at(-1)).toMatchObject({ type: 'done', status: 'succeeded' });
    const again = await signedInject(app, key, { method: 'POST', url: '/v1/jobs', body });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'duplicate_job' });
  });
});
