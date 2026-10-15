import type { ExecutionIdentity, OutboundExecutor } from '../execution/types';

/**
 * Email and Teams delivery for schedules (report files, failure alerts) and approval requests (R6).
 * - Recipients and webhook URLs are configuration: content names an env key (`${ env.AF_REPORT_RECIPIENTS }`) and the
 *   value is read here from the installation's configuration, never from content and never exposed to expressions.
 * - Email goes through Microsoft Graph `sendMail` as the automation identity, from the mailbox in AF_MAIL_SENDER
 *   (needs the Mail.Send application permission and an Exchange Online mailbox).
 * - Teams uses a Workflows/incoming webhook URL; only Microsoft webhook hosts are accepted (no SSRF to other hosts).
 */

const ENV_REF = /^\s*\$\{\s*env\.([A-Z][A-Z0-9_]*)\s*\}\s*$/;
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** Microsoft-hosted webhook endpoints (Teams Workflows / Power Automate, legacy connectors). */
const WEBHOOK_HOSTS =
  /(^|\.)(webhook\.office\.com|logic\.azure\.com|environment\.api\.powerplatform\.com|powerautomate\.com)$/i;
/** sendMail accepts attachments up to ~3 MB in a single request; larger files are linked instead. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const AUTOMATION_WRITE: ExecutionIdentity = { kind: 'automation', mode: 'write' };

export interface DeliveryDeps {
  outbound: OutboundExecutor;
  fetch: typeof fetch;
  /** Installation configuration (env file + process env) for `${ env.X }` references. */
  env: Record<string, string | undefined>;
  publicBaseUrl: string;
}

export type DeliveryStatus = {
  type: 'email' | 'teams';
  status: 'sent' | 'failed' | 'not_configured';
  message: string;
};

/** `${ env.X }` → the configured value; anything else is taken literally. */
function resolveRef(
  ref: string,
  env: DeliveryDeps['env'],
): { value: string | undefined; key: string | null } {
  const m = ENV_REF.exec(ref);
  return m
    ? { value: env[m[1]!]?.trim() || undefined, key: m[1]! }
    : { value: ref.trim() || undefined, key: null };
}

/** Recipients from templates: each may be an address or `${ env.X }` holding addresses (comma/semicolon separated). */
export function resolveRecipients(
  list: readonly string[],
  env: DeliveryDeps['env'],
): { to: string[]; missing: string[] } {
  const to: string[] = [];
  const missing: string[] = [];
  for (const item of list) {
    const { value, key } = resolveRef(item, env);
    if (!value) {
      if (key) missing.push(key);
      continue;
    }
    for (const a of value.split(/[;,]/).map((s) => s.trim()))
      if (EMAIL.test(a) && !to.includes(a.toLowerCase())) to.push(a.toLowerCase());
  }
  return { to, missing };
}

/** The webhook URL for `${ env.X }`, or why it can't be used. */
export function resolveWebhook(
  ref: string | undefined,
  env: DeliveryDeps['env'],
): { url?: string; problem?: string } {
  if (!ref) return { problem: 'No webhook is configured for this Teams target.' };
  const { value, key } = resolveRef(ref, env);
  if (!key) return { problem: 'Teams webhooks must be an ${ env.X } reference (the URL is a secret).' };
  if (!value) return { problem: `${key} is not set in the configuration.` };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: `${key} is not a URL.` };
  }
  if (url.protocol !== 'https:' || !WEBHOOK_HOSTS.test(url.hostname))
    return { problem: `${key} must be an https Teams/Workflows webhook on a Microsoft host.` };
  return { url: url.toString() };
}

export interface Message {
  title: string;
  text: string;
  /** Link into AdminForge (absolute). */
  link?: string;
  attachment?: { name: string; contentType: string; bytes: Buffer };
}

/** Posts an Adaptive Card to a Teams Workflows webhook. Never follows redirects. */
export async function postTeams(
  deps: DeliveryDeps,
  ref: string | undefined,
  msg: Message,
): Promise<DeliveryStatus> {
  const hook = resolveWebhook(ref, deps.env);
  if (!hook.url) return { type: 'teams', status: 'not_configured', message: hook.problem! };
  const card = {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: msg.title, weight: 'Bolder', size: 'Medium', wrap: true },
            { type: 'TextBlock', text: msg.text, wrap: true },
          ],
          ...(msg.link
            ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in AdminForge', url: msg.link }] }
            : {}),
        },
      },
    ],
  };
  try {
    const res = await deps.fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok
      ? { type: 'teams', status: 'sent', message: 'Posted to Teams.' }
      : { type: 'teams', status: 'failed', message: `The Teams webhook answered ${res.status}.` };
  } catch (err) {
    return {
      type: 'teams',
      status: 'failed',
      message: `The Teams webhook could not be reached (${(err as Error).name}).`,
    };
  }
}

/** Sends a plain-text email with Graph sendMail as the automation identity, from AF_MAIL_SENDER. */
export async function sendEmail(
  deps: DeliveryDeps,
  recipients: { to: readonly string[]; cc?: readonly string[] },
  msg: Message,
  correlationId: string,
): Promise<DeliveryStatus> {
  const sender = deps.env.AF_MAIL_SENDER?.trim();
  if (!sender || !EMAIL.test(sender))
    return {
      type: 'email',
      status: 'not_configured',
      message: 'Set AF_MAIL_SENDER to the mailbox reports are sent from.',
    };
  const to = resolveRecipients(recipients.to, deps.env);
  const cc = resolveRecipients(recipients.cc ?? [], deps.env);
  if (!to.to.length)
    return {
      type: 'email',
      status: 'not_configured',
      message: to.missing.length
        ? `${to.missing.join(', ')} is not set in the configuration.`
        : 'No valid recipient addresses.',
    };
  const attach =
    msg.attachment && msg.attachment.bytes.length <= MAX_ATTACHMENT_BYTES ? msg.attachment : undefined;
  const linkNote =
    msg.attachment && !attach && msg.link
      ? `\n\nThe file is too large to attach; download it here: ${msg.link}`
      : '';
  const address = (a: string) => ({ emailAddress: { address: a } });
  try {
    await deps.outbound.execute(
      AUTOMATION_WRITE,
      {
        service: 'graph',
        method: 'POST',
        path: `/users/${encodeURIComponent(sender)}/sendMail`,
        pathTemplate: '/users/{sender}/sendMail',
        declaredWrite: true,
        body: {
          message: {
            subject: msg.title,
            body: {
              contentType: 'Text',
              content: `${msg.text}${msg.link && !linkNote ? `\n\n${msg.link}` : ''}${linkNote}`,
            },
            toRecipients: to.to.map(address),
            ...(cc.to.length ? { ccRecipients: cc.to.map(address) } : {}),
            ...(attach
              ? {
                  attachments: [
                    {
                      '@odata.type': '#microsoft.graph.fileAttachment',
                      name: attach.name,
                      contentType: attach.contentType,
                      contentBytes: attach.bytes.toString('base64'),
                    },
                  ],
                }
              : {}),
          },
          saveToSentItems: false,
        },
      },
      { correlationId },
    );
    return { type: 'email', status: 'sent', message: `Sent to ${to.to.length} recipient(s).` };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    const hint =
      e.status === 403
        ? ' The automation identity needs the Mail.Send application permission (AF_AUTOMATION_ALLOW_WRITE_PERMISSIONS=true, then provision entra) and AF_MAIL_SENDER needs an Exchange Online mailbox.'
        : '';
    return { type: 'email', status: 'failed', message: `${e.message ?? 'Email could not be sent.'}${hint}` };
  }
}

/**
 * Tells approvers a request is waiting (AF_APPROVALS_EMAIL and/or AF_APPROVALS_TEAMS_WEBHOOK). Unconfigured → nothing
 * is sent and the request still shows in the portal's Approvals inbox.
 */
export async function notifyApprovers(
  deps: DeliveryDeps,
  request: { title: string; requestedBy: string | null; path: string },
  correlationId: string,
): Promise<DeliveryStatus[]> {
  const msg: Message = {
    title: `Approval needed: ${request.title}`,
    text: `${request.requestedBy ?? 'Someone'} asked for approval of "${request.title}". Review it in AdminForge; you can't approve your own request.`,
    link: `${deps.publicBaseUrl}${request.path}`,
  };
  const out: DeliveryStatus[] = [];
  if (deps.env.AF_APPROVALS_EMAIL?.trim())
    out.push(await sendEmail(deps, { to: ['${ env.AF_APPROVALS_EMAIL }'] }, msg, correlationId));
  if (deps.env.AF_APPROVALS_TEAMS_WEBHOOK?.trim())
    out.push(await postTeams(deps, '${ env.AF_APPROVALS_TEAMS_WEBHOOK }', msg));
  return out;
}
