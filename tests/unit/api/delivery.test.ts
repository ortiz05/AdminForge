import {
  MAX_ATTACHMENT_BYTES,
  notifyApprovers,
  postTeams,
  resolveRecipients,
  resolveWebhook,
  sendEmail,
  type DeliveryDeps,
} from '@adminforge/api/src/delivery/notifier';
import type { ExecutionIdentity, ServiceCall } from '@adminforge/api/src/execution/types';

// Email (Graph sendMail as the automation identity) and Teams (Workflows webhook) delivery. Recipients and webhooks
// come from configuration via ${ env.X }; webhooks are restricted to Microsoft hosts.
const HOOK = 'https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x';

function deps(env: Record<string, string> = {}, fail?: number) {
  const calls: Array<{ identity: ExecutionIdentity; call: ServiceCall }> = [];
  const posts: Array<{ url: string; init: RequestInit }> = [];
  const d: DeliveryDeps = {
    outbound: {
      execute: async (identity: ExecutionIdentity, call: ServiceCall) => {
        calls.push({ identity, call });
        if (fail) throw Object.assign(new Error('Access is denied.'), { status: fail });
        return { data: null, status: 202, provenance: { service: 'graph', path: '/x', ms: 1 } };
      },
    } as unknown as DeliveryDeps['outbound'],
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, init });
      return new Response('', { status: 202 });
    }) as unknown as typeof fetch,
    env: { AF_MAIL_SENDER: 'reports@example.com', ...env },
    publicBaseUrl: 'https://portal.example.com',
  };
  return { d, calls, posts };
}

describe('recipients and webhooks come from configuration', () => {
  it('expands ${ env.X } into addresses and reports unset keys', () => {
    expect(
      resolveRecipients(['${ env.AF_REPORT_RECIPIENTS }', 'ops@example.com', '${ env.AF_MISSING }'], {
        AF_REPORT_RECIPIENTS: 'a@example.com; B@example.com',
      }),
    ).toEqual({ to: ['a@example.com', 'b@example.com', 'ops@example.com'], missing: ['AF_MISSING'] });
  });

  it('accepts only https webhooks on Microsoft hosts, by env reference', () => {
    expect(resolveWebhook('${ env.H }', { H: HOOK }).url).toBe(HOOK);
    expect(resolveWebhook('${ env.H }', { H: 'https://attacker.example.com/hook' }).problem).toMatch(
      /Microsoft host/,
    );
    expect(resolveWebhook(HOOK, {}).problem).toMatch(/env\.X/);
    expect(resolveWebhook('${ env.H }', {}).problem).toMatch(/not set/);
  });
});

describe('Teams', () => {
  it('posts an Adaptive Card with an Open link and never follows redirects', async () => {
    const { d, posts } = deps({ H: HOOK });
    const r = await postTeams(d, '${ env.H }', {
      title: 'Report ready',
      text: '12 rows',
      link: 'https://portal.example.com/schedules/x',
    });
    expect(r.status).toBe('sent');
    expect(posts[0]!.init.redirect).toBe('error');
    const card = JSON.parse(String(posts[0]!.init.body));
    expect(card.attachments[0].content.actions[0].url).toBe('https://portal.example.com/schedules/x');
  });
});

describe('email', () => {
  it('sends with Graph sendMail as the automation identity (write), attaching small files', async () => {
    const { d, calls } = deps({ AF_REPORT_RECIPIENTS: 'a@example.com' });
    const r = await sendEmail(
      d,
      { to: ['${ env.AF_REPORT_RECIPIENTS }'] },
      {
        title: 'Weekly',
        text: 'Done',
        attachment: { name: 'r.xlsx', contentType: 'application/x', bytes: Buffer.from('xlsx') },
      },
      'corr-1',
    );
    expect(r.status).toBe('sent');
    expect(calls[0]!.identity).toEqual({ kind: 'automation', mode: 'write' });
    expect(calls[0]!.call).toMatchObject({
      method: 'POST',
      path: '/users/reports%40example.com/sendMail',
      declaredWrite: true,
    });
    const body = calls[0]!.call.body as {
      message: { attachments: Array<{ name: string }>; toRecipients: unknown[] };
    };
    expect(body.message.attachments[0]!.name).toBe('r.xlsx');
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'a@example.com' } }]);
  });

  it('links instead of attaching large files', async () => {
    const { d, calls } = deps({ T: 'a@example.com' });
    await sendEmail(
      d,
      { to: ['${ env.T }'] },
      {
        title: 't',
        text: 'x',
        link: 'https://portal.example.com/schedules/x',
        attachment: {
          name: 'big.csv',
          contentType: 'text/csv',
          bytes: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1),
        },
      },
      'c',
    );
    const body = calls[0]!.call.body as { message: { attachments?: unknown; body: { content: string } } };
    expect(body.message.attachments).toBeUndefined();
    expect(body.message.body.content).toMatch(/too large to attach.*portal\.example\.com/);
  });

  it('explains what is missing instead of failing silently', async () => {
    expect(
      (
        await sendEmail(
          deps({ AF_MAIL_SENDER: '' }).d,
          { to: ['a@example.com'] },
          { title: 't', text: 'x' },
          'c',
        )
      ).status,
    ).toBe('not_configured');
    const denied = await sendEmail(
      deps({}, 403).d,
      { to: ['a@example.com'] },
      { title: 't', text: 'x' },
      'c',
    );
    expect(denied).toMatchObject({ status: 'failed' });
    expect(denied.message).toMatch(/Mail\.Send/);
  });
});

describe('approver notifications', () => {
  it('uses AF_APPROVALS_EMAIL and AF_APPROVALS_TEAMS_WEBHOOK when set, nothing otherwise', async () => {
    const none = deps();
    expect(
      await notifyApprovers(
        none.d,
        { title: 'Disable', requestedBy: 'avery@example.com', path: '/runs/1' },
        'c',
      ),
    ).toEqual([]);
    const both = deps({ AF_APPROVALS_EMAIL: 'approvers@example.com', AF_APPROVALS_TEAMS_WEBHOOK: HOOK });
    const r = await notifyApprovers(
      both.d,
      { title: 'Disable', requestedBy: 'avery@example.com', path: '/runs/1' },
      'c',
    );
    expect(r.map((x) => [x.type, x.status])).toEqual([
      ['email', 'sent'],
      ['teams', 'sent'],
    ]);
  });
});
