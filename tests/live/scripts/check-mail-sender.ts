// Live: checks report email the way schedules send it — AdminForge's own notifier (delivery/notifier.ts `sendEmail`,
// Graph sendMail as the automation identity) — without mailing anyone: one short message from AF_MAIL_SENDER to
// AF_MAIL_SENDER itself. With --not-as <display name> (repeatable) it also tries to send AS that mailbox (again only to
// AF_MAIL_SENDER) and expects Exchange to refuse: the automation identity may send only as the report mailbox
// (Exchange RBAC for Applications scoped to it, Entra Mail.Send withheld). Prints statuses only.
//
// No database is used, so it may read the services' configuration too (ADMINFORGE_ENV_OVERLAY=host).
// Usage (repository root):
//   pnpm exec tsx tests/live/scripts/check-mail-sender.ts [--not-as AF-Test-Shared-01]…
//   … --sender-name "AF-Test-…"   check a test mailbox before AF_MAIL_SENDER is set (looked up by display name)
// Only test mailboxes (display name AF-Test-…) are accepted for --not-as and --sender-name (or, for --sender-name,
// the mailbox AF_MAIL_SENDER already names): mail is never sent as anyone else's mailbox.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadEnv } from '@adminforge/config';
import { mask } from '../lib/mask';

const { values } = parseArgs({
  options: { 'not-as': { type: 'string', multiple: true }, 'sender-name': { type: 'string' } },
  allowPositionals: false,
});

/** Display names of the live suite's test mailboxes (AF-Test-Shared-01, AF-Test-Room-01, …). */
const TEST_MAILBOX = /^AF-Test-[A-Za-z0-9][A-Za-z0-9-]{0,60}$/;
for (const name of values['not-as'] ?? [])
  if (!TEST_MAILBOX.test(name))
    throw new Error(
      '--not-as accepts only test mailboxes (display name AF-Test-…): this check sends as the mailbox it names.',
    );

const { loadConfig } = await import('@adminforge/api/src/config');
const { createContext } = await import('@adminforge/api/src/context');
const { sendEmail } = await import('@adminforge/api/src/delivery/notifier');

const config = loadConfig();
const ctx = createContext(config, { database: null }, { warn: () => undefined });
if (!ctx.automation) throw new Error('The automation identity is not configured in the env file.');

/** The mailbox address of a user object with this display name (exactly one), read as the automation identity. */
async function mailboxNamed(name: string): Promise<{ mail?: string; count: number }> {
  const found = await ctx.outbound.execute<{ value: Array<{ mail?: string | null }> }>(
    { kind: 'automation', mode: 'read' },
    {
      service: 'graph',
      method: 'GET',
      path: '/users',
      query: { $filter: `displayName eq '${name.replace(/'/g, "''")}'`, $select: 'mail' },
    },
    { correlationId: randomUUID() },
  );
  const count = found.data.value.length;
  return { mail: count === 1 ? (found.data.value[0]!.mail ?? undefined) : undefined, count };
}

const configured = loadEnv().AF_MAIL_SENDER?.trim();
let sender = configured;
if (values['sender-name']) {
  const name = values['sender-name'];
  const m = await mailboxNamed(name);
  if (!m.mail) throw new Error(`--sender-name: ${m.count} mailbox(es) with that name; need exactly one.`);
  if (!TEST_MAILBOX.test(name) && m.mail.toLowerCase() !== configured?.toLowerCase())
    throw new Error(
      '--sender-name accepts only a test mailbox (display name AF-Test-…) or the mailbox AF_MAIL_SENDER names.',
    );
  sender = m.mail;
}
if (!sender) throw new Error('AF_MAIL_SENDER is not set in the env file (or pass --sender-name).');
console.log(`sender: ${values['sender-name'] ? 'the mailbox named by --sender-name' : 'AF_MAIL_SENDER'}`);

const refuse: typeof fetch = async () => {
  throw new Error('Teams is not used by this check');
};
/** Delivery as `from`; the only recipient list resolves to the report mailbox itself. */
const deps = (from: string) => ({
  outbound: ctx.outbound,
  fetch: refuse,
  env: { AF_MAIL_SENDER: from, AF_MAIL_SENDER_CHECK_RECIPIENTS: sender },
  publicBaseUrl: config.PUBLIC_BASE_URL,
});
const to = { to: ['${ env.AF_MAIL_SENDER_CHECK_RECIPIENTS }'] };
const message = (n: number) => ({
  title: `AdminForge delivery check ${n}`,
  text: 'Automated check that AdminForge can send report email from this mailbox (sent to itself). No action needed.',
});
/** Microsoft's reason, first sentence only, with addresses and ids masked (it never names the recipient). */
const reason = (m: string) =>
  mask(m.split(/(?<=\.)\s/)[0] ?? '')
    .replace(/[^\s@<>"',;]+@[^\s@<>"',;]+/g, '<address>')
    .slice(0, 160);
const refusal = (m: string) =>
  `${/\b403\b|AccessDenied|Access is denied|not allowed|Mail\.Send/i.test(m) ? 'refused (access denied)' : 'failed (other error)'}: ${reason(m)}`;

let problems = 0;
const own = await sendEmail(deps(sender), to, message(1), randomUUID());
if (own.status !== 'sent') problems++;
console.log(
  `send as the sender to itself: ${own.status}${own.status === 'sent' ? '' : ` — ${refusal(own.message)}`}`,
);

for (const name of values['not-as'] ?? []) {
  const { mail: other, count } = await mailboxNamed(name);
  if (!other || other.toLowerCase() === sender.toLowerCase()) {
    problems++;
    console.log(
      `send as ${name}: skipped — ${count} mailbox(es) with that name, need exactly one other than the sender`,
    );
    continue;
  }
  const r = await sendEmail(deps(other), to, message(2), randomUUID());
  if (r.status === 'sent') problems++;
  console.log(
    `send as ${name} (to the sender): ${
      r.status === 'sent'
        ? 'SENT — the automation identity can send as other mailboxes (Entra Mail.Send granted, or the Exchange scope is wider than the sender)'
        : refusal(r.message)
    }`,
  );
}
await ctx.definitions.close().catch(() => undefined);
process.exit(problems ? 1 : 0);
