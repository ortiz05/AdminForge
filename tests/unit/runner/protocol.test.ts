import { readNdjson } from '@adminforge/runner/src/client';
import { LineSplitter } from '@adminforge/runner/src/pool';
import {
  type RunnerEvent,
  RunnerEventSchema,
  RunnerJobRequestSchema,
  encodeEvent,
  parseWorkerLine,
} from '@adminforge/runner/src/protocol';
import { TENANT } from './helpers';

const base = {
  jobId: 'run-1:step-2',
  script: { path: 'exchange/Get-MailboxForwarding.ps1', sha256: 'a'.repeat(64) },
  mode: 'read',
  tenant: TENANT,
};

describe('job request schema', () => {
  it('accepts a minimal job and applies defaults', () => {
    const job = RunnerJobRequestSchema.parse(base);
    expect(job).toMatchObject({ inputs: {}, tokens: {}, timeoutSeconds: 300 });
  });

  it('accepts all token kinds and a SharePoint tenant name', () => {
    const tokens = { graph: 'g', exchange: 'e', teams: 't', sharepointAdmin: 's', arm: 'a' };
    expect(
      RunnerJobRequestSchema.safeParse({
        ...base,
        tokens,
        tenant: { ...TENANT, spoTenantName: 'example' },
        timeoutSeconds: 1800,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a timeout above 30 minutes', { timeoutSeconds: 1801 }],
    ['a fractional timeout', { timeoutSeconds: 1.5 }],
    ['an unknown token service', { tokens: { intune: 'x' } }],
    ['an unknown top-level field', { command: 'Remove-Item /' }],
    ['an unknown mode', { mode: 'admin' }],
    ['a job id with spaces', { jobId: 'run 1' }],
    ['a script path that escapes', { script: { path: '../x.ps1', sha256: 'a'.repeat(64) } }],
    ['an upper-case sha256', { script: { path: 'x/Y.ps1', sha256: 'A'.repeat(64) } }],
    ['inputs that are not an object', { inputs: ['a'] }],
    ['a tenant id that is not a GUID', { tenant: { ...TENANT, id: 'contoso' } }],
    [
      'a SharePoint name that would change the URL',
      { tenant: { ...TENANT, spoTenantName: 'evil.example.net/x' } },
    ],
    ['a domain with a path', { tenant: { ...TENANT, domain: 'example.com/x' } }],
  ])('rejects %s', (_label, patch) => {
    expect(RunnerJobRequestSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});

describe('worker line parsing', () => {
  const now = () => new Date('2026-10-15T00:00:00.000Z');

  it('passes well-formed events through', () => {
    expect(
      parseWorkerLine('{"type":"log","level":"warn","message":"m","ts":"2026-10-15T01:02:03Z"}'),
    ).toEqual({ type: 'log', level: 'warn', message: 'm', ts: '2026-10-15T01:02:03Z' });
    expect(parseWorkerLine('{"type":"progress","percent":42.5,"message":"x"}')).toEqual({
      type: 'progress',
      percent: 42.5,
      message: 'x',
    });
    expect(parseWorkerLine('{"type":"output","data":{"rows":[1,2]}}')).toEqual({
      type: 'output',
      data: { rows: [1, 2] },
    });
    expect(parseWorkerLine('{"type":"error","message":"no","category":"readOnly"}')).toEqual({
      type: 'error',
      message: 'no',
      category: 'readOnly',
    });
    expect(parseWorkerLine('{"type":"exit","status":"succeeded"}')).toEqual({
      type: 'exit',
      status: 'succeeded',
    });
  });

  it('extracts ready info without the type field', () => {
    expect(parseWorkerLine('{"type":"ready","pid":12,"pwsh":"7.6.7","modules":[]}')).toEqual({
      type: 'ready',
      info: { pid: 12, pwsh: '7.6.7', modules: [] },
    });
  });

  it('normalises sloppy events instead of failing', () => {
    expect(parseWorkerLine('{"type":"log","level":"loud","message":5}', now)).toEqual({
      type: 'log',
      level: 'info',
      message: '5',
      ts: now().toISOString(),
    });
    expect(parseWorkerLine('{"type":"progress","percent":250}')).toMatchObject({ percent: 100, message: '' });
    expect(parseWorkerLine('{"type":"progress","percent":"lots"}')).toMatchObject({ percent: 0 });
    expect(parseWorkerLine('{"type":"error","category":"weird"}')).toEqual({
      type: 'error',
      message: 'Script failed',
      category: 'script',
    });
    expect(parseWorkerLine('{"type":"output"}')).toEqual({ type: 'output', data: null });
    expect(parseWorkerLine('{"type":"exit","status":"great"}')).toEqual({ type: 'exit', status: 'failed' });
  });

  it('turns stray text into log lines and ignores blank lines', () => {
    expect(parseWorkerLine('WARNING: something', now)).toEqual({
      type: 'log',
      level: 'info',
      message: 'WARNING: something',
      ts: now().toISOString(),
    });
    expect(parseWorkerLine('[1,2]', now)).toMatchObject({ type: 'log', message: '[1,2]' });
    expect(parseWorkerLine('   ')).toBeUndefined();
  });

  it('never lets a worker forge supervisor events', () => {
    for (const type of ['accepted', 'done', 'mystery']) {
      expect(parseWorkerLine(JSON.stringify({ type, status: 'succeeded', jobId: 'x' }))).toMatchObject({
        type: 'log',
        level: 'warn',
      });
    }
  });

  it('truncates huge messages', () => {
    const msg = parseWorkerLine(JSON.stringify({ type: 'log', message: 'x'.repeat(20_000) }));
    expect(msg?.type === 'log' && msg.message.length).toBeLessThan(17_000);
  });
});

describe('NDJSON encoding', () => {
  const events: RunnerEvent[] = [
    { type: 'accepted', jobId: 'j1' },
    { type: 'log', level: 'info', message: 'line\nwith newline and ü', ts: '2026-10-15T00:00:00.000Z' },
    { type: 'progress', percent: 10, message: '' },
    { type: 'output', data: { a: [1, { b: null }] } },
    { type: 'error', message: 'nope', category: 'script' },
    { type: 'done', status: 'failed', durationMs: 12 },
  ];

  it('encodes one event per line and round-trips through the schema', () => {
    const text = events.map(encodeEvent).join('');
    expect(text.split('\n')).toHaveLength(events.length + 1);
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .map((l) => RunnerEventSchema.parse(JSON.parse(l))),
    ).toEqual(events);
  });

  it('readNdjson handles chunk boundaries, split UTF-8 characters and keep-alive blank lines', async () => {
    const bytes = Buffer.from(`\n${events.map(encodeEvent).join('\n')}\n\n`);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const out: unknown[] = [];
    for await (const value of readNdjson(stream)) out.push(value);
    expect(out).toEqual(events);
  });

  it('LineSplitter emits complete lines across chunks and stops on oversized lines', () => {
    const lines: string[] = [];
    let overflow = 0;
    const splitter = new LineSplitter(
      (l) => lines.push(l),
      10,
      () => overflow++,
    );
    splitter.push(Buffer.from('ab'));
    splitter.push(Buffer.from('c\r\nde\nf'));
    splitter.end();
    expect(lines).toEqual(['abc', 'de', 'f']);
    const big = new LineSplitter(
      (l) => lines.push(l),
      10,
      () => overflow++,
    );
    big.push('x'.repeat(11));
    big.push('\nlater\n');
    expect(overflow).toBe(1);
    expect(lines).toEqual(['abc', 'de', 'f']);
  });
});
