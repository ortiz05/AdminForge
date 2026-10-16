import {
  escapeMarkdown,
  postTeams,
  sendEmail,
  type DeliveryDeps,
} from '@adminforge/api/src/delivery/notifier';
import type { ServiceCall } from '@adminforge/api/src/execution/types';

// Teams Adaptive Cards render Markdown: untrusted text (names typed in the portal, error messages) is escaped so it
// shows as typed and can't pose as a link or format itself; Markdown written in reviewed content keeps working.

const HOOK = 'https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x';

function deps() {
  const posts: Array<{ url: string; body: string }> = [];
  const mails: ServiceCall[] = [];
  const d: DeliveryDeps = {
    outbound: {
      execute: async (_i: unknown, call: ServiceCall) => {
        mails.push(call);
        return { data: null, status: 202, provenance: { service: 'graph', path: '/x', ms: 1 } };
      },
    } as unknown as DeliveryDeps['outbound'],
    fetch: (async (url: string, init: RequestInit) => {
      posts.push({ url, body: String(init.body) });
      return new Response('', { status: 202 });
    }) as unknown as typeof fetch,
    env: { AF_MAIL_SENDER: 'reports@example.com', AF_R_RECIPIENTS: 'it@example.com', H: HOOK },
    publicBaseUrl: 'https://portal.example.com',
  };
  return { d, posts, mails };
}

const blocks = (body: string) =>
  (JSON.parse(body) as { attachments: Array<{ content: { body: Array<{ text: string }> } }> }).attachments[0]!
    .content.body;

describe('escapeMarkdown', () => {
  it.each([
    ['Inactive users (90 days), weekly', 'Inactive users (90 days), weekly'],
    ['[Click here](https://example.com)', '\\[Click here\\](https://example.com)'],
    ['**urgent** _now_ `code` ~gone~', '\\*\\*urgent\\*\\* \\_now\\_ \\`code\\` \\~gone\\~'],
    ['<img src=x>', '\\<img src=x\\>'],
    ['- not a list\n+ nor this\n# nor a heading', '\\- not a list\n\\+ nor this\n\\# nor a heading'],
    ['1. not numbered', '1\\. not numbered'],
    ['a - b, 3.5 % and C:\\path', 'a - b, 3.5 % and C:\\\\path'],
  ])('%j → %j', (input, output) => expect(escapeMarkdown(input)).toBe(output));
});

describe('postTeams and sendEmail', () => {
  it('escapes the title and text, keeps reviewed Markdown as written', async () => {
    const { d, posts } = deps();
    await postTeams(d, '${ env.H }', {
      title: '[Pay here](https://evil.example)',
      markdown: 'See the **weekly** numbers.',
      text: 'Schedule: *X*.\nScheduled in AdminForge by avery@example.com.',
    });
    expect(blocks(posts[0]!.body).map((b) => b.text)).toEqual([
      '\\[Pay here\\](https://evil.example)',
      'See the **weekly** numbers.',
      'Schedule: \\*X\\*.\nScheduled in AdminForge by avery@example.com.',
    ]);
  });

  it('a message without reviewed Markdown has two blocks; email joins Markdown and text as plain text', async () => {
    const { d, posts, mails } = deps();
    await postTeams(d, '${ env.H }', { title: 'Report', text: 'It ran.' });
    expect(blocks(posts[0]!.body)).toHaveLength(2);
    await sendEmail(
      d,
      { to: ['${ env.AF_R_RECIPIENTS }'] },
      { title: 'Report', markdown: 'Intro.', text: 'It ran.' },
      'c1',
    );
    const content = (mails[0]!.body as { message: { body: { content: string } } }).message.body.content;
    expect(content).toBe('Intro.\nIt ran.');
  });
});
