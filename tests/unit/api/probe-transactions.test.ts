import { ApiError } from '@adminforge/connectors';
import { runProbe, type ProbeDeps } from '@adminforge/api/src/probes/checks';
import { AppError } from '@adminforge/api/src/errors';
import type { ExecutionIdentity, OutboundExecutor, ServiceCall } from '@adminforge/api/src/execution/types';
import { Probe } from '@adminforge/schemas';

// Synthetic transactions: mail flow, a SharePoint file round trip and a Teams meeting. Each acts only on the test
// objects named in configuration, declares its writes (write mode, declaredWrite) while reads stay in read mode, and
// removes what it made — also when the check itself fails.
const NOW = new Date('2026-10-17T12:00:00.000Z');
const TOKEN = '0123456789abcdef';
const SENDER = 'reports@example.com';
const MAILBOX = 'af-synthetic@example.com';
const SITE =
  'example.sharepoint.com,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
// The mailboxes' object ids, as the lookup by address finds them.
const SENDER_ID = '44444444-4444-4444-8444-444444444444';
const MAILBOX_ID = '55555555-5555-4555-8555-555555555555';
const ENV = {
  AF_MAIL_SENDER: SENDER,
  AF_SYNTHETIC_MAILBOX: MAILBOX,
  AF_SYNTHETIC_SITE_ID: SITE,
  AF_SYNTHETIC_USER_ID: USER,
};

const probe = (check: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  Probe.parse({
    kind: 'probe',
    id: 'probes.tx',
    version: '1.0.0',
    title: 'Transaction',
    owner: 'test',
    check,
    timeoutMs: 110_000,
    ...extra,
  });

type Call = ServiceCall & { identity: ExecutionIdentity };
type Answer = (call: Call) => unknown;

function deps(answer: Answer, opts: { env?: Record<string, unknown>; fetch?: typeof fetch } = {}) {
  const calls: Call[] = [];
  const outbound = {
    execute: async (identity: ExecutionIdentity, call: ServiceCall) => {
      const c = { identity, ...call };
      calls.push(c);
      const out = answer(c);
      if (out instanceof Error) throw out;
      return { status: 200, data: out ?? {} };
    },
  } as unknown as OutboundExecutor;
  const fetched: string[] = [];
  const d: ProbeDeps = {
    outbound,
    automation: null,
    connection: async () => {
      throw new Error('no connections');
    },
    env: () => opts.env ?? ENV,
    now: () => NOW,
    fetch:
      opts.fetch ??
      (async (url) => {
        fetched.push(String(url));
        return new Response(JSON.stringify({ token: TOKEN }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    sleep: async () => undefined,
    randomId: () => `${TOKEN}-rest-ignored`,
  };
  return { d, calls, fetched };
}

const mailFlow = (extra: Record<string, unknown> = {}) =>
  probe({ kind: 'mailFlow', waitSeconds: 30, ...extra }, { thresholds: { warn: 30, crit: 75 } });
const message = (subject: string, extra: Record<string, unknown> = {}) => ({
  id: `m-${subject.slice(-4)}`,
  subject,
  sentDateTime: '2026-10-17T12:00:01Z',
  receivedDateTime: '2026-10-17T12:00:04Z',
  parentFolderId: 'inbox-id',
  ...extra,
});
const ours = message(`AdminForge mail flow check ${TOKEN}`);

/** The account lookup by address: the sender and the test mailbox each match one account. */
function account(c: Call): unknown {
  const f = String(c.query?.$filter ?? '');
  if (f.includes(`'${SENDER}'`)) return { value: [{ id: SENDER_ID }] };
  if (f.includes(`'${MAILBOX}'`)) return { value: [{ id: MAILBOX_ID }] };
  return { value: [] };
}

/**
 * Mail answers: the message arrives on the given poll (1-based) among `extra` recent messages; `stale` are older
 * messages (the leftover query); Junk Email has `junk` as its id.
 */
function mailbox(
  arriveOnPoll: number,
  opts: { junk?: string; extra?: unknown[]; stale?: unknown[] } = {},
): Answer {
  let polls = 0;
  return (c) => {
    if (c.path === '/users') return account(c);
    if (c.path.endsWith('/messages') && c.method === 'GET') {
      if (String(c.query?.$filter).includes('receivedDateTime lt')) return { value: opts.stale ?? [] };
      polls++;
      return { value: [...(polls >= arriveOnPoll ? [ours] : []), ...(opts.extra ?? [])] };
    }
    if (c.path.endsWith('/mailFolders/junkemail')) return { id: opts.junk ?? 'junk-id' };
    return {};
  };
}

describe('mailFlow', () => {
  it('sends as a declared write, reads back in read mode, deletes the message and reports seconds', async () => {
    const { d, calls } = deps(mailbox(2));
    const out = await runProbe('probes.tx', mailFlow(), d);
    expect(out).toMatchObject({ status: 'ok', code: 'ok', unit: 's' });
    expect(out.metric).toBe(5); // two polls: 2 s + 3 s
    // Both mailboxes are looked up by address first, in read mode.
    expect(calls.slice(0, 2).map((c) => [c.method, c.path, c.identity.mode])).toEqual([
      ['GET', '/users', 'read'],
      ['GET', '/users', 'read'],
    ]);
    expect(calls[0]!.query).toMatchObject({
      $filter: `mail eq '${SENDER}' or userPrincipalName eq '${SENDER}'`,
    });
    const send = calls[2]!;
    expect(send).toMatchObject({
      method: 'POST',
      path: `/users/${SENDER_ID}/sendMail`,
      declaredWrite: true,
      identity: { kind: 'automation', mode: 'write' },
    });
    const body = send.body as {
      message: { subject: string; toRecipients: unknown[] };
      saveToSentItems: boolean;
    };
    expect(body.message.subject).toBe(`AdminForge mail flow check ${TOKEN}`);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: MAILBOX } }]);
    expect(body.saveToSentItems).toBe(false);
    const reads = calls.filter((c) => c.method === 'GET');
    expect(reads.every((c) => c.identity.mode === 'read' && !c.declaredWrite)).toBe(true);
    expect(reads[2]!.path).toBe(`/users/${MAILBOX_ID}/messages`);
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatchObject({
      path: `/users/${MAILBOX_ID}/messages/${ours.id}`,
      declaredWrite: true,
      identity: { mode: 'write' },
    });
    expect(out.message).toMatch(/Delivered from reports@example\.com to af-synthetic@example\.com in 5 s/);
    expect(out.details?.rows[0]).toMatchObject({ exchangeSeconds: 3, cleanup: 'deleted 1' });
  });

  it('is critical when the message doesn’t arrive in time; deletes only stale test messages, never a running check’s', async () => {
    const concurrent = message('AdminForge mail flow check ffffffffffffffff');
    const late = message('AdminForge mail flow check eeeeeeeeeeeeeeee', {
      receivedDateTime: '2026-10-17T11:40:00Z',
    });
    const other = message('Quarterly results');
    const { d, calls } = deps(mailbox(99, { extra: [concurrent, other], stale: [late, other] }));
    const out = await runProbe('probes.tx', mailFlow(), d);
    expect(out).toMatchObject({ status: 'crit', code: 'not_delivered', metric: null });
    expect(out.message).toMatch(/didn’t reach af-synthetic@example\.com/);
    const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    expect(deleted).toEqual([`/users/${MAILBOX_ID}/messages/${late.id}`]);
    // Stale = received before the wait (30 s) and two more minutes, before sending.
    const staleQuery = calls.find((c) => String(c.query?.$filter).includes('receivedDateTime lt'));
    expect(staleQuery?.query?.$filter).toBe('receivedDateTime lt 2026-10-17T11:57:30Z');
    // 30 s budget: polls at 2, 5, 8 … 29 s, then it stops.
    expect(
      calls.filter(
        (c) =>
          c.method === 'GET' && c.path.endsWith('/messages') && String(c.query?.$filter).includes(' ge '),
      ),
    ).toHaveLength(10);
  });

  it('warns when the message lands in Junk Email', async () => {
    const { d } = deps(mailbox(1, { junk: 'inbox-id' }));
    const out = await runProbe('probes.tx', mailFlow(), d);
    expect(out).toMatchObject({ status: 'warn', code: 'junk' });
    expect(out.message).toMatch(/Junk Email/);
  });

  it('warns when the test message can’t be deleted, but keeps the delivery time', async () => {
    const answer = mailbox(1);
    const { d } = deps((c) =>
      c.method === 'DELETE' ? new ApiError(403, 'ErrorAccessDenied', 'Access is denied.') : answer(c),
    );
    const out = await runProbe('probes.tx', mailFlow(), d);
    expect(out).toMatchObject({ status: 'warn', code: 'cleanup_failed', metric: 2 });
  });

  it('turns a refused send into a permission error that names the Exchange role to assign', async () => {
    const { d, calls } = deps((c) =>
      c.method === 'POST' ? new ApiError(403, 'ErrorAccessDenied', 'Access is denied.') : account(c),
    );
    const out = await runProbe('probes.tx', mailFlow(), d);
    expect(out).toMatchObject({ status: 'error', code: 'forbidden' });
    expect(out.message).toMatch(/Sending the test message was refused for the automation identity \(403\)/);
    expect(out.message).toMatch(/Application Mail\.Send/);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST']);
  });

  it('says so when the test mailbox isn’t an account in the tenant, before sending', async () => {
    const { d, calls } = deps(() => ({ value: [] }));
    const out = await runProbe('probes.tx', mailFlow(), d);
    expect(out).toMatchObject({ status: 'error', code: 'not_configured' });
    expect(out.message).toMatch(/AF_MAIL_SENDER \(reports@example\.com\) isn’t a mailbox in this tenant/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('refuses a target that isn’t a synthetic test object, even when the stored definition names one', async () => {
    const p = mailFlow();
    (p.check as { to: string }).to = '${ env.AF_REPORT_RECIPIENTS }';
    const { d, calls } = deps(() => ({}), { env: { ...ENV, AF_REPORT_RECIPIENTS: 'finance@example.com' } });
    const out = await runProbe('probes.tx', p, d);
    expect(out).toMatchObject({ status: 'error', code: 'content_error' });
    expect(calls).toHaveLength(0);
  });

  it('changes nothing when the test mailbox isn’t configured', async () => {
    const { d, calls } = deps(() => ({}), { env: { AF_MAIL_SENDER: SENDER } });
    const out = await runProbe('probes.tx', mailFlow(), d);
    expect(out).toMatchObject({ status: 'error', code: 'not_configured' });
    expect(out.message).toMatch(/AF_SYNTHETIC_MAILBOX is not set/);
    expect(calls).toHaveLength(0);
  });

  it('refuses to run with a person’s access', async () => {
    const { d, calls } = deps(() => ({}));
    const grant = { kind: 'grant', mode: 'read', grant: {} } as unknown as ExecutionIdentity;
    const out = await runProbe('probes.tx', mailFlow(), d, { identity: grant });
    expect(out).toMatchObject({ status: 'error', code: 'content_error' });
    expect(calls).toHaveLength(0);
  });

  it('reports a paused emergency stop instead of sending', async () => {
    const paused = new AppError(503, 'writes_paused', 'An administrator has paused all changes.');
    const { d } = deps((c) => (c.declaredWrite ? paused : account(c)));
    const out = await runProbe('probes.tx', mailFlow(), d);
    expect(out).toMatchObject({ status: 'error', code: 'writes_paused' });
  });
});

describe('fileRoundTrip', () => {
  const download = 'https://example.sharepoint.com/sites/af/_layouts/15/download.aspx?UniqueId=x&tempauth=y';
  const leftover = { id: 'old', name: 'adminforge-check-aaaa.json', createdDateTime: '2026-10-17T09:00:00Z' };
  const fresh = { id: 'busy', name: 'adminforge-check-bbbb.json', createdDateTime: '2026-10-17T11:59:00Z' };
  const files =
    (item: Record<string, unknown>): Answer =>
    (c) =>
      c.method === 'PUT'
        ? item
        : c.path.endsWith(':/children')
          ? {
              value: [
                leftover,
                fresh,
                { id: 'doc', name: 'Report.docx', createdDateTime: '2026-01-01T00:00:00Z' },
              ],
            }
          : {};

  it('uploads a JSON file, downloads it from SharePoint, compares and deletes it (and old leftovers)', async () => {
    const { d, calls, fetched } = deps(
      files({ id: 'item-1', size: 16_384, '@microsoft.graph.downloadUrl': download }),
    );
    const out = await runProbe('probes.tx', probe({ kind: 'fileRoundTrip' }), d);
    expect(out).toMatchObject({ status: 'ok', unit: 'ms' });
    const put = calls[0]!;
    expect(put).toMatchObject({
      method: 'PUT',
      path: `/sites/${encodeURIComponent(SITE)}/drive/root:/AdminForge%20synthetic%20checks/adminforge-check-${TOKEN}.json:/content`,
      declaredWrite: true,
      identity: { mode: 'write' },
    });
    expect(JSON.stringify(put.body).length).toBeGreaterThanOrEqual(16 * 1024);
    expect(fetched).toEqual([download]);
    const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
    expect(deleted).toEqual([
      `/sites/${encodeURIComponent(SITE)}/drive/items/item-1`,
      `/sites/${encodeURIComponent(SITE)}/drive/items/old`,
    ]);
    expect(out.message).toMatch(/Uploaded, downloaded and deleted a 16 KB file/);
    expect(out.message).toMatch(/1 leftover test file/);
  });

  it('never fetches a download address outside SharePoint, and still deletes the upload', async () => {
    const { d, calls, fetched } = deps(
      files({ id: 'item-1', '@microsoft.graph.downloadUrl': 'https://attacker.example.com/file' }),
    );
    const out = await runProbe('probes.tx', probe({ kind: 'fileRoundTrip' }), d);
    expect(out).toMatchObject({ status: 'crit', code: 'expectation_failed' });
    expect(fetched).toEqual([]);
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/items/item-1'))).toBe(true);
  });

  it('is critical when SharePoint returns a different file', async () => {
    const { d } = deps(files({ id: 'item-1', '@microsoft.graph.downloadUrl': download }), {
      fetch: async () => new Response(JSON.stringify({ token: 'other' })),
    });
    const out = await runProbe('probes.tx', probe({ kind: 'fileRoundTrip' }), d);
    expect(out).toMatchObject({ status: 'crit', code: 'expectation_failed' });
    expect(out.message).toMatch(/isn’t the one uploaded/);
  });

  it('names Sites.Selected when the upload is refused', async () => {
    const { d } = deps((c) => (c.method === 'PUT' ? new ApiError(403, 'accessDenied', 'Access denied') : {}));
    const out = await runProbe('probes.tx', probe({ kind: 'fileRoundTrip' }), d);
    expect(out).toMatchObject({ status: 'error', code: 'forbidden' });
    expect(out.message).toMatch(/Sites\.Selected/);
  });

  it('wants a Graph site id', async () => {
    const { d, calls } = deps(() => ({}), {
      env: { ...ENV, AF_SYNTHETIC_SITE_ID: 'https://example.sharepoint.com/sites/x' },
    });
    const out = await runProbe('probes.tx', probe({ kind: 'fileRoundTrip' }), d);
    expect(out).toMatchObject({ status: 'error', code: 'not_configured' });
    expect(calls).toHaveLength(0);
  });
});

describe('onlineMeeting', () => {
  it('creates a meeting an hour ahead as a declared write and deletes it', async () => {
    const { d, calls } = deps((c) =>
      c.method === 'POST' ? { id: 'meet-1', joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/x' } : {},
    );
    const out = await runProbe('probes.tx', probe({ kind: 'onlineMeeting' }), d);
    expect(out).toMatchObject({ status: 'ok', unit: 'ms' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: `/users/${USER}/onlineMeetings`,
      declaredWrite: true,
      identity: { mode: 'write' },
      body: { startDateTime: '2026-10-17T13:00:00Z', endDateTime: '2026-10-17T13:30:00Z' },
    });
    expect(calls[1]).toMatchObject({
      method: 'DELETE',
      path: `/users/${USER}/onlineMeetings/meet-1`,
      declaredWrite: true,
    });
  });

  it('is critical without a join link, and still deletes the meeting', async () => {
    const { d, calls } = deps((c) => (c.method === 'POST' ? { id: 'meet-1' } : {}));
    const out = await runProbe('probes.tx', probe({ kind: 'onlineMeeting' }), d);
    expect(out).toMatchObject({ status: 'crit', code: 'expectation_failed' });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
  });

  it('names the Teams application access policy when Teams refuses', async () => {
    const { d } = deps(
      () => new ApiError(403, 'Forbidden', 'No application access policy found for this app.'),
    );
    const out = await runProbe('probes.tx', probe({ kind: 'onlineMeeting' }), d);
    expect(out).toMatchObject({ status: 'error', code: 'forbidden' });
    expect(out.message).toMatch(/application access policy/);
  });
});

describe('transaction content rules', () => {
  it('only takes AF_SYNTHETIC_… test objects from configuration (and the report sender as a sender)', () => {
    for (const check of [
      { kind: 'mailFlow', to: 'someone@example.com' },
      { kind: 'mailFlow', to: '${ env.AF_REPORT_RECIPIENTS }' },
      { kind: 'mailFlow', to: '${ env.AF_MAIL_SENDER }' },
      { kind: 'mailFlow', from: '${ env.AF_APPROVALS_EMAIL }' },
      { kind: 'fileRoundTrip', site: SITE },
      { kind: 'onlineMeeting', organizer: "${ env.AF_SYNTHETIC_USER_ID & '' }" },
      { kind: 'onlineMeeting', organizer: '${ env.AF_PROTECTED_USER_IDS }' },
    ])
      expect(() => probe(check), JSON.stringify(check)).toThrow(
        /synthetic transactions act only on test objects named in configuration/,
      );
    expect(() =>
      probe({ kind: 'mailFlow', from: '${ env.AF_SYNTHETIC_SENDER }', to: '${ env.AF_SYNTHETIC_MAILBOX }' }),
    ).not.toThrow();
  });

  it('gives a mail check room to wait and clean up', () => {
    expect(() => probe({ kind: 'mailFlow', waitSeconds: 90 }, { timeoutMs: 60_000 })).toThrow(
      /set timeoutMs to at least 100000/,
    );
    expect(() => probe({ kind: 'mailFlow', waitSeconds: 90 }, { timeoutMs: 100_000 })).not.toThrow();
  });
});

describe('signInHealth for one workload', () => {
  it('filters the sign-in log by resource', async () => {
    const { d, calls } = deps(() => ({ value: [] }));
    await runProbe(
      'probes.tx',
      probe({
        kind: 'signInHealth',
        window: 'PT1H',
        maxFailurePercent: 30,
        resourceId: '00000002-0000-0ff1-ce00-000000000000',
      }),
      d,
    );
    expect(String(calls[0]!.query?.$filter)).toBe(
      "createdDateTime ge 2026-10-17T11:00:00Z and resourceId eq '00000002-0000-0ff1-ce00-000000000000'",
    );
  });
});
