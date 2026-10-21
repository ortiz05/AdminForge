import { randomUUID } from 'node:crypto';
import { ApiError, readBodyText } from '@adminforge/connectors';
import { isGuid, syntheticTargetKey, type ProbeCheck } from '@adminforge/schemas';
import { AppError } from '../errors';
import { readableMessage } from '../execution/outbound';
import { identityName, type ExecutionIdentity, type ServiceCall } from '../execution/types';
import type { CheckContext, CheckResult, ProbeDetails } from './checks';
import { classify, worst } from './thresholds';

/**
 * Synthetic transactions (docs/operations.md › Synthetic transactions): probes that exercise a Microsoft 365 workload
 * the way a person does — mail goes through, a file uploads and downloads, a Teams meeting is created — and then remove
 * what they made. They are built in, not content: a probe picks only its kind, its waits and the test objects, and
 * those are `${ env.AF_SYNTHETIC_… }` keys (configuration, never content; mail may also come from AF_MAIL_SENDER), read
 * here straight from configuration. Mailboxes are addressed by object id, so the protected-object guard sees whose they
 * are. Every call that changes something is declared a write here, so the request policy, the emergency stop and the
 * protected-object guard all apply; reads stay in the identity's read mode. They run only as an app identity (the automation identity or a named one), whose
 * permissions an administrator scopes to the test objects (Exchange RBAC for Applications, Sites.Selected, a Teams
 * application access policy).
 */

type MailFlow = Extract<ProbeCheck, { kind: 'mailFlow' }>;
type FileRoundTrip = Extract<ProbeCheck, { kind: 'fileRoundTrip' }>;
type OnlineMeeting = Extract<ProbeCheck, { kind: 'onlineMeeting' }>;

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** A Graph site id: `<host>,<site collection id>,<web id>` (or another id Graph accepts in /sites/{id}). */
const SITE_ID = /^[A-Za-z0-9.-]+(,[0-9a-f-]{36}){2}$|^[0-9a-f-]{36}$/i;
/** Hosts SharePoint serves file downloads from: commercial and GCC, GCC High, DoD, 21Vianet, Microsoft's own (df). */
const SHAREPOINT_HOST =
  /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(sharepoint\.com|sharepoint\.us|sharepoint-mil\.us|sharepoint\.cn|sharepoint-df\.com)$/i;
/** Test items this module creates carry this marker; leftovers from earlier runs are recognised by it. */
const MAIL_SUBJECT = 'AdminForge mail flow check';
const FILE_PREFIX = 'adminforge-check-';
/** Room left after the mail wait for the junk check and the cleanup. */
const CLEANUP_RESERVE_MS = 10_000;
/** Leftover test items removed per run at most (earlier runs that timed out or couldn't clean up). */
const MAX_LEFTOVERS = 5;
/** A test message counts as left over this long after the wait it belonged to (never a run still waiting for it). */
const LEFTOVER_AFTER_MS = 120_000;
const POLL_FIRST_MS = 2_000;
const POLL_EVERY_MS = 3_000;

const ms = (t0: number) => Math.round(performance.now() - t0);
const seconds = (millis: number) => Math.round(millis / 100) / 10;
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

const notConfigured = (message: string, hint: string) =>
  new AppError(503, 'not_configured', message, { hint });

const defaultSleep = (wait: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, wait);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
  });

/**
 * The test object a target names, read straight from configuration (never evaluated as an expression): only
 * `AF_SYNTHETIC_…` keys (and AF_MAIL_SENDER for a sender) — checked again here, since published content isn't
 * re-validated when it is loaded. Not configured when the key is empty.
 */
function configured(
  x: CheckContext,
  template: string,
  what: string,
  opts: { sender?: boolean } = {},
): { key: string; value: string } {
  const key = syntheticTargetKey(template, opts);
  if (!key)
    throw new AppError(400, 'content_error', `The probe names ${what} that isn’t a synthetic test object.`, {
      hint: 'Use one ${ env.AF_SYNTHETIC_… } reference (a mail check may also send from ${ env.AF_MAIL_SENDER }).',
    });
  const raw = (x.scope.env as Record<string, unknown> | undefined)?.[key];
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!value)
    throw notConfigured(
      `${key} is not set, so there is no ${what} to test with.`,
      `Set ${key} in the env file to a dedicated test object (docs/operations.md › Synthetic transactions), or turn the probe off.`,
    );
  return { key, value };
}

/** The identity the transaction's writes go out as: the schedule's app identity, in write mode. */
function writer(x: CheckContext): ExecutionIdentity {
  if (x.identity.kind !== 'automation')
    throw new AppError(
      400,
      'content_error',
      'Synthetic transactions run as an app identity, never with a person’s access.',
      { hint: 'Run this probe from a schedule whose identity is automation or a named app identity.' },
    );
  return { ...x.identity, mode: 'write' };
}

interface Step {
  /** "Sending the test message" — what was being done, for the message. */
  label: string;
  /** What to grant when Microsoft refuses it (401/403). */
  denied: string;
  /** What is missing when Microsoft answers 404 (the configured object doesn't exist). */
  missing?: string;
}

/** One call, with a refusal or a missing test object turned into a message that says what to fix. */
async function call<T>(x: CheckContext, identity: ExecutionIdentity, req: ServiceCall, step: Step) {
  try {
    return await x.deps.outbound.execute<T>(
      identity,
      { ...req, requires: x.probe.requires },
      { signal: x.signal, correlationId: x.correlationId },
    );
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403))
      throw new AppError(
        403,
        'forbidden',
        `${step.label} was refused for ${identityName(identity)} (${err.status}): ${readableMessage(err.message)}`,
        { hint: step.denied },
      );
    if (err instanceof ApiError && err.status === 404 && step.missing)
      throw notConfigured(`${step.label} failed: ${step.missing}`, step.denied);
    throw err;
  }
}

/** Removes a test item; a failure is reported on the result, never thrown (the check itself already ran). */
async function cleanup(
  x: CheckContext,
  identity: ExecutionIdentity,
  req: Omit<ServiceCall, 'method' | 'declaredWrite'>,
): Promise<string | null> {
  try {
    await x.deps.outbound.execute(
      identity,
      { ...req, method: 'DELETE', declaredWrite: true, requires: x.probe.requires },
      { signal: x.signal, correlationId: x.correlationId },
    );
    return null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    const status = err instanceof ApiError ? ` (${err.status})` : '';
    return `${err instanceof Error ? readableMessage(err.message) : String(err)}${status}`;
  }
}

const marker = (x: CheckContext) => (x.deps.randomId ?? randomUUID)().replace(/-/g, '').slice(0, 16);

// ── Mail flow ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface GraphMessage {
  id: string;
  subject?: string | null;
  receivedDateTime?: string;
  sentDateTime?: string;
  parentFolderId?: string;
}

/**
 * A mailbox's object id from its address (mail or UPN), so the calls name the account and the protected-object guard
 * can recognise it. Exactly one account must match.
 */
async function accountId(x: CheckContext, address: string, key: string, denied: string): Promise<string> {
  const quoted = address.replace(/'/g, "''");
  const res = await call<{ value?: Array<{ id?: string }> }>(
    x,
    x.identity,
    {
      service: 'graph',
      method: 'GET',
      path: '/users',
      query: { $filter: `mail eq '${quoted}' or userPrincipalName eq '${quoted}'`, $select: 'id', $top: 2 },
    },
    { label: `Looking up ${address}`, denied },
  );
  const ids = (res.data?.value ?? []).map((u) => u.id).filter((id): id is string => !!id && isGuid(id));
  if (ids.length !== 1)
    throw notConfigured(
      ids.length
        ? `${key} (${address}) matches more than one account.`
        : `${key} (${address}) isn’t a mailbox in this tenant.`,
      `Set ${key} to the address of a dedicated test mailbox.`,
    );
  return ids[0]!;
}

const mailDenied = (from: string, to: string) =>
  `Give the identity Exchange RBAC for Applications scoped to the test mailboxes: "Application Mail.Send" for ${from} and "Application Mail.ReadWrite" for ${to} (docs/operations.md › Synthetic transactions).`;

export async function mailFlow(c: MailFlow, x: CheckContext): Promise<CheckResult> {
  const sender = configured(x, c.from, 'a mailbox to send from', { sender: true });
  const mailbox = configured(x, c.to, 'a test mailbox to deliver to');
  for (const t of [sender, mailbox])
    if (!EMAIL.test(t.value))
      throw notConfigured(
        `${t.key} is not one email address.`,
        'Set it to the address of a dedicated test mailbox.',
      );
  const from = sender.value;
  const to = mailbox.value;
  const write = writer(x);
  const denied = mailDenied(from, to);
  const fromId = await accountId(x, from, sender.key, denied);
  const toId = await accountId(x, to, mailbox.key, denied);
  const inbox = `/users/${encodeURIComponent(toId)}`;
  const token = marker(x);
  const subject = `${MAIL_SUBJECT} ${token}`;
  const sentAt = x.deps.now();
  const t0 = performance.now();
  await call(
    x,
    write,
    {
      service: 'graph',
      method: 'POST',
      path: `/users/${encodeURIComponent(fromId)}/sendMail`,
      pathTemplate: '/users/{sender}/sendMail',
      declaredWrite: true,
      body: {
        message: {
          subject,
          body: {
            contentType: 'Text',
            content:
              'AdminForge sends this message to check that mail flows between these mailboxes, reads it back and deletes it. No action is needed.',
          },
          toRecipients: [{ emailAddress: { address: to } }],
          internetMessageHeaders: [{ name: 'X-AdminForge-Check', value: token }],
        },
        saveToSentItems: false,
      },
    },
    { label: 'Sending the test message', denied, missing: `${from} has no mailbox.` },
  );
  const sendMs = ms(t0);

  // Look in every folder (a junk verdict or an inbox rule shouldn't read as "not delivered"), newest first.
  const since = iso(new Date(sentAt.getTime() - 60_000));
  const budget = Math.min(
    c.waitSeconds * 1000,
    x.timeoutMs - (performance.now() - x.startedAt) - CLEANUP_RESERVE_MS,
  );
  const sleep = x.deps.sleep ?? defaultSleep;
  let found: GraphMessage | undefined;
  let polls = 0;
  // Time since sending: the clock, but never less than the waits so far (a test's sleep returns at once).
  let waited = 0;
  const since0 = () => Math.max(ms(t0), waited);
  for (;;) {
    const wait = polls === 0 ? POLL_FIRST_MS : POLL_EVERY_MS;
    if (polls > 0 && since0() + wait > budget) break;
    await sleep(wait, x.signal);
    waited += wait;
    polls++;
    const res = await call<{ value?: GraphMessage[] }>(
      x,
      x.identity,
      {
        service: 'graph',
        method: 'GET',
        path: `${inbox}/messages`,
        pathTemplate: '/users/{mailbox}/messages',
        query: {
          $filter: `receivedDateTime ge ${since}`,
          $orderby: 'receivedDateTime desc',
          $select: 'id,subject,receivedDateTime,sentDateTime,parentFolderId',
          $top: 25,
        },
      },
      { label: 'Reading the test mailbox', denied, missing: `${to} has no mailbox.` },
    );
    // Only this run's message: another check running at the same time keeps its own.
    // (A transport rule may tag the subject, e.g. "[External] …": look for it inside.)
    found = (res.data?.value ?? []).find((m) => m.subject?.includes(subject));
    if (found) break;
  }
  const elapsed = since0();
  const rows: ProbeDetails['rows'] = [];
  const row = {
    from,
    to,
    sentAt: iso(sentAt),
    sendMs,
    receivedAt: found?.receivedDateTime ?? null,
    endToEndSeconds: found ? seconds(elapsed) : null,
    exchangeSeconds:
      found?.receivedDateTime && found.sentDateTime
        ? seconds(Date.parse(found.receivedDateTime) - Date.parse(found.sentDateTime))
        : null,
    folder: null as string | null,
    cleanup: null as string | null,
  };
  rows.push(row);

  const notes: string[] = [];
  let status: CheckResult['status'];
  let code: string | undefined;
  if (found) {
    const junk = await call<{ id?: string }>(
      x,
      x.identity,
      {
        service: 'graph',
        method: 'GET',
        path: `${inbox}/mailFolders/junkemail`,
        pathTemplate: '/users/{mailbox}/mailFolders/junkemail',
        query: { $select: 'id' },
      },
      { label: 'Reading the test mailbox’s Junk Email folder', denied },
    ).catch(() => undefined);
    if (junk?.data?.id && junk.data.id === found.parentFolderId) {
      row.folder = 'Junk Email';
      notes.push('it landed in Junk Email');
      status = 'warn';
      code = 'junk';
    } else row.folder = 'Inbox or a folder a rule chose';
  }
  if (c.cleanup) {
    const leftovers = await staleMessages(x, inbox, sentAt, c.waitSeconds);
    const remove = [...(found ? [found] : []), ...leftovers];
    const failures: string[] = [];
    for (const m of remove) {
      const failed = await cleanup(x, write, {
        service: 'graph',
        path: `${inbox}/messages/${encodeURIComponent(m.id)}`,
        pathTemplate: '/users/{mailbox}/messages/{id}',
      });
      if (failed) failures.push(failed);
    }
    row.cleanup = failures.length
      ? `failed: ${failures[0]}`
      : remove.length
        ? `deleted ${remove.length}`
        : 'nothing to delete';
    if (failures.length) {
      notes.push(`the test message couldn’t be deleted (${failures[0]})`);
      code ??= 'cleanup_failed';
      status = worst(status ?? 'ok', 'warn');
    } else if (leftovers.length)
      notes.push(`${leftovers.length} late message(s) from earlier checks deleted`);
  }
  if (!found)
    return {
      metric: null,
      status: 'crit',
      code: 'not_delivered',
      message: `The test message from ${from} didn’t reach ${to} within ${seconds(elapsed)} s.${notes.length ? ` Also: ${notes.join('; ')}.` : ''}`,
      details: { rows },
    };
  const metric = seconds(elapsed);
  return {
    metric,
    // A junk verdict or a failed cleanup is at least degraded, whatever the delivery time.
    ...(status ? { status: worst(status, classify(metric, x.thresholds)) } : {}),
    ...(code ? { code } : {}),
    message: `Delivered from ${from} to ${to} in ${metric} s${row.exchangeSeconds !== null ? ` (Exchange: ${row.exchangeSeconds} s from sent to received)` : ''}${notes.length ? `; ${notes.join('; ')}` : ''}.`,
    details: { rows },
  };
}

/**
 * Test messages earlier runs left behind (they arrived after their run gave up, or couldn't be deleted): this module's
 * subject, received well before any run that could still be waiting for them. Best effort; at most a few per run.
 */
async function staleMessages(
  x: CheckContext,
  inbox: string,
  sentAt: Date,
  waitSeconds: number,
): Promise<GraphMessage[]> {
  const before = iso(new Date(sentAt.getTime() - waitSeconds * 1000 - LEFTOVER_AFTER_MS));
  try {
    const res = await x.deps.outbound.execute<{ value?: GraphMessage[] }>(
      x.identity,
      {
        service: 'graph',
        method: 'GET',
        path: `${inbox}/messages`,
        pathTemplate: '/users/{mailbox}/messages',
        query: {
          $filter: `receivedDateTime lt ${before}`,
          $orderby: 'receivedDateTime desc',
          $select: 'id,subject,receivedDateTime',
          $top: 25,
        },
        requires: x.probe.requires,
      },
      { signal: x.signal, correlationId: x.correlationId },
    );
    return (res.data?.value ?? [])
      .filter((m) => m.id && m.subject?.startsWith(`${MAIL_SUBJECT} `))
      .slice(0, MAX_LEFTOVERS);
  } catch {
    return [];
  }
}

// ── SharePoint file round trip ─────────────────────────────────────────────────────────────────────────────────────

interface DriveItem {
  id?: string;
  name?: string;
  size?: number;
  createdDateTime?: string;
  '@microsoft.graph.downloadUrl'?: string;
}

const siteDenied = (site: string) =>
  `Grant the identity the Sites.Selected application permission and write access to the test site only (POST /sites/${site}/permissions with roles ["write"]); see docs/operations.md › Synthetic transactions.`;

export async function fileRoundTrip(c: FileRoundTrip, x: CheckContext): Promise<CheckResult> {
  const { key: siteKey, value: site } = configured(x, c.site, 'a SharePoint test site');
  if (!SITE_ID.test(site))
    throw notConfigured(
      `${siteKey} is not a Graph site id.`,
      'Use the site’s id as GET /sites/<host>:/sites/<path> returns it (<host>,<site collection id>,<web id>).',
    );
  const write = writer(x);
  const denied = siteDenied(site);
  const token = marker(x);
  const name = `${FILE_PREFIX}${token}.json`;
  const base = `/sites/${encodeURIComponent(site)}/drive`;
  const folder = encodeURIComponent(c.folder);
  const header = { check: 'AdminForge synthetic file round trip', token, createdAt: iso(x.deps.now()) };
  const padding = Math.max(0, c.sizeKb * 1024 - JSON.stringify({ ...header, padding: '' }).length);
  const payload = { ...header, padding: 'x'.repeat(padding) };

  const t0 = performance.now();
  const up = await call<DriveItem>(
    x,
    write,
    {
      service: 'graph',
      method: 'PUT',
      path: `${base}/root:/${folder}/${encodeURIComponent(name)}:/content`,
      pathTemplate: '/sites/{site}/drive/root:/{folder}/{file}:/content',
      declaredWrite: true,
      body: payload,
    },
    { label: 'Uploading the test file', denied, missing: `${site} has no default document library.` },
  );
  const uploadMs = ms(t0);
  const item = up.data ?? {};
  const row = {
    site,
    folder: c.folder,
    file: name,
    bytes: item.size ?? null,
    uploadMs,
    downloadMs: null as number | null,
    deleteMs: null as number | null,
    cleanup: null as string | null,
  };
  let problem: { code: string; message: string } | null = null;
  try {
    const url = item['@microsoft.graph.downloadUrl'];
    let host = '';
    try {
      const u = new URL(url ?? '');
      host = u.protocol === 'https:' && u.port === '' ? u.hostname : '';
    } catch {
      host = '';
    }
    if (!item.id || !SHAREPOINT_HOST.test(host))
      problem = {
        code: 'expectation_failed',
        message: 'SharePoint accepted the upload but didn’t return a SharePoint download address for it.',
      };
    else {
      const t1 = performance.now();
      const res = await x.deps.fetch(url!, { signal: x.signal, redirect: 'manual' });
      const { text } = await readBodyText(res, 2 * 1024 * 1024, { onLimit: 'truncate' });
      row.downloadMs = ms(t1);
      let same = false;
      try {
        same = res.ok && (JSON.parse(text) as { token?: string }).token === token;
      } catch {
        same = false;
      }
      if (!same)
        problem = {
          code: 'expectation_failed',
          message: res.ok
            ? 'The file SharePoint returned isn’t the one uploaded.'
            : `Downloading the test file from SharePoint returned ${res.status}.`,
        };
    }
  } finally {
    if (item.id) {
      const t2 = performance.now();
      const failed = await cleanup(x, write, {
        service: 'graph',
        path: `${base}/items/${encodeURIComponent(item.id)}`,
        pathTemplate: '/sites/{site}/drive/items/{id}',
      });
      row.deleteMs = ms(t2);
      row.cleanup = failed ? `failed: ${failed}` : 'deleted';
    }
  }
  const leftovers = await sweepFiles(x, write, base, folder, name);
  const elapsed = ms(t0);
  const details: ProbeDetails = { rows: [row] };
  if (problem)
    return { metric: elapsed, status: 'crit', code: problem.code, message: problem.message, details };
  const notes = [
    ...(row.cleanup?.startsWith('failed')
      ? [`the test file couldn’t be deleted (${row.cleanup.slice(8)})`]
      : []),
    ...(leftovers ? [`${leftovers} leftover test file(s) from earlier checks deleted`] : []),
  ];
  const cleanupFailed = row.cleanup?.startsWith('failed') ?? false;
  return {
    metric: elapsed,
    ...(cleanupFailed
      ? { status: worst('warn', classify(elapsed, x.thresholds)), code: 'cleanup_failed' }
      : {}),
    message: `Uploaded, downloaded and deleted a ${Math.round((item.size ?? 0) / 1024)} KB file in ${elapsed} ms (upload ${uploadMs} ms, download ${row.downloadMs} ms, delete ${row.deleteMs} ms)${notes.length ? `; ${notes.join('; ')}` : ''}.`,
    details,
  };
}

/** Deletes test files that earlier runs left behind (older than an hour); best effort, the count it removed. */
async function sweepFiles(
  x: CheckContext,
  write: ExecutionIdentity,
  base: string,
  folder: string,
  current: string,
): Promise<number> {
  try {
    const res = await x.deps.outbound.execute<{ value?: DriveItem[] }>(
      x.identity,
      {
        service: 'graph',
        method: 'GET',
        path: `${base}/root:/${folder}:/children`,
        pathTemplate: '/sites/{site}/drive/root:/{folder}:/children',
        query: { $select: 'id,name,createdDateTime', $top: 50 },
        requires: x.probe.requires,
      },
      { signal: x.signal, correlationId: x.correlationId },
    );
    const hourAgo = x.deps.now().getTime() - 3_600_000;
    const old = (res.data?.value ?? [])
      .filter(
        (i) =>
          i.id &&
          i.name?.startsWith(FILE_PREFIX) &&
          i.name !== current &&
          Date.parse(i.createdDateTime ?? '') < hourAgo,
      )
      .slice(0, MAX_LEFTOVERS);
    let removed = 0;
    for (const i of old)
      if (
        !(await cleanup(x, write, {
          service: 'graph',
          path: `${base}/items/${encodeURIComponent(i.id!)}`,
          pathTemplate: '/sites/{site}/drive/items/{id}',
        }))
      )
        removed++;
    return removed;
  } catch {
    return 0;
  }
}

// ── Teams online meeting ───────────────────────────────────────────────────────────────────────────────────────────

interface GraphOnlineMeeting {
  id?: string;
  joinWebUrl?: string;
  joinUrl?: string;
}

const meetingDenied = (user: string) =>
  `Grant the identity OnlineMeetings.ReadWrite.All and a Teams application access policy for the test user only (New-CsApplicationAccessPolicy, then Grant-CsApplicationAccessPolicy -Identity ${user}); see docs/operations.md › Synthetic transactions.`;

export async function onlineMeeting(c: OnlineMeeting, x: CheckContext): Promise<CheckResult> {
  const { key: organizerKey, value: organizer } = configured(x, c.organizer, 'a Teams test user');
  if (!isGuid(organizer))
    throw notConfigured(
      `${organizerKey} is not a user object id.`,
      'Set it to the test user’s object id (Entra ID › Users › the user › Object ID).',
    );
  const write = writer(x);
  const denied = meetingDenied(organizer);
  const token = marker(x);
  const start = new Date(x.deps.now().getTime() + 3_600_000);
  const t0 = performance.now();
  const created = await call<GraphOnlineMeeting>(
    x,
    write,
    {
      service: 'graph',
      method: 'POST',
      path: `/users/${encodeURIComponent(organizer)}/onlineMeetings`,
      pathTemplate: '/users/{organizer}/onlineMeetings',
      declaredWrite: true,
      body: {
        subject: `AdminForge synthetic check ${token}`,
        startDateTime: iso(start),
        endDateTime: iso(new Date(start.getTime() + 1_800_000)),
      },
    },
    { label: 'Creating the test meeting', denied, missing: `${organizer} isn’t a user in this tenant.` },
  );
  const createMs = ms(t0);
  const meeting = created.data ?? {};
  const join = meeting.joinWebUrl ?? meeting.joinUrl ?? '';
  const row = { organizer, createMs, deleteMs: null as number | null, cleanup: null as string | null };
  if (meeting.id) {
    const t1 = performance.now();
    const failed = await cleanup(x, write, {
      service: 'graph',
      path: `/users/${encodeURIComponent(organizer)}/onlineMeetings/${encodeURIComponent(meeting.id)}`,
      pathTemplate: '/users/{organizer}/onlineMeetings/{id}',
    });
    row.deleteMs = ms(t1);
    row.cleanup = failed ? `failed: ${failed}` : 'deleted';
  }
  const details: ProbeDetails = { rows: [row] };
  if (!meeting.id || !/^https:\/\//.test(join))
    return {
      metric: createMs,
      status: 'crit',
      code: 'expectation_failed',
      message: 'Teams accepted the meeting request but returned no meeting or join link.',
      details,
    };
  const cleanupFailed = row.cleanup?.startsWith('failed') ?? false;
  return {
    metric: createMs,
    ...(cleanupFailed
      ? { status: worst('warn', classify(createMs, x.thresholds)), code: 'cleanup_failed' }
      : {}),
    message: `Created a Teams meeting with a join link in ${createMs} ms and deleted it${row.deleteMs !== null ? ` (${row.deleteMs} ms)` : ''}${cleanupFailed ? `; deleting it failed (${row.cleanup!.slice(8)})` : ''}.`,
    details,
  };
}
