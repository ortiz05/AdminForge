/**
 * Shared by the S-08 tests (arm-rotates-session.test.ts on memory stores, arm-rotates-session-db.test.ts on SQLite):
 * arming through the mock route and reading back the cookie and CSRF token the browser then holds, the session hash a
 * cookie stands for, a stream reader for the SSE endpoints, a gate that holds a Microsoft call open, and the playbooks
 * the runs scenarios use.
 */
import { createHash } from 'node:crypto';
import { cookieFrom, getMe } from './helpers';
import { StaticDefinitions } from './runs-helpers';
import type { App } from './support/app';

export const USER = '00000000-0000-4000-8000-000000000001';
export const TAP = 'Tap-Secret-5150-Value';
export const OPERATOR = ['Portal.Reader', 'Portal.Operator'];
export const APPROVER = ['Portal.Reader', 'Portal.Operator', 'Playbook.Approver'];

/** sha256 of the session id in a `name=value` cookie: what the stores key the session by. */
export const hashOf = (cookie: string) =>
  createHash('sha256')
    .update(cookie.slice(cookie.indexOf('=') + 1))
    .digest('hex');

/** Arms through POST /auth/arm (mock mode: at once) and returns the cookie and CSRF token the browser then holds. */
export async function armMock(app: App, headers: { cookie: string; 'x-adminforge-csrf': string }) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/arm',
    headers,
    payload: { minutes: 30, reason: 'Disable a test user' },
  });
  if (res.statusCode !== 200) throw new Error(`arming failed: ${res.statusCode} ${res.body}`);
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error('arming set no session cookie');
  const { me } = await getMe(app, cookie);
  return { res, cookie, csrf: me!.csrf, headers: { cookie, 'x-adminforge-csrf': me!.csrf } };
}

/** Polls until `check` holds (no fixed sleeps). */
export async function waitFor(check: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A promise the test resolves: holds a fake Microsoft call open while the session is rotated. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** Reads an SSE response from a listening app; `until(null)` waits for the server to end the stream. */
export async function openStream(url: string, cookie: string) {
  const res = await fetch(url, { headers: { cookie } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const state = { status: res.status, text: '', done: false };
  const until = async (needle: string | null, ms = 5000) => {
    const stop = Date.now() + ms;
    while (needle === null ? !state.done : !state.text.includes(needle)) {
      if (Date.now() > stop) throw new Error(`stream never contained ${needle ?? 'its end'}`);
      const { done, value } = await reader.read();
      if (done) {
        state.done = true;
        break;
      }
      state.text += decoder.decode(value, { stream: true });
    }
  };
  return { state, until, close: () => reader.cancel().catch(() => undefined) };
}

/**
 * `test.two-reads` reads twice as its initiator (the first call can be held open with a gate); `test.tap-approved`
 * waits for an approval, reads as the approver, then issues a Temporary Access Pass (a show-once secret for the
 * initiator); `test.tap` issues one straight away.
 */
export function rotationDefinitions() {
  const create = {
    id: 'create',
    type: 'graph',
    mode: 'write',
    describe: 'Create a Temporary Access Pass',
    request: {
      method: 'POST',
      path: '/users/${ $encode(inputs.userId) }/authentication/temporaryAccessPassMethods',
      body: { lifetimeInMinutes: 60 },
    },
    secretOutputs: ['temporaryAccessPass'],
  };
  const base = { owner: 'tests', version: '1.0.0', risk: 'low' } as const;
  const inputs = { userId: { type: 'string', format: 'guid' } };
  return new StaticDefinitions()
    .add({
      kind: 'playbook',
      id: 'test.two-reads',
      title: 'Two reads',
      ...base,
      mode: 'read',
      inputs,
      steps: [
        { id: 'first', type: 'graph', mode: 'read', request: { method: 'GET', path: '/users/first' } },
        { id: 'second', type: 'graph', mode: 'read', request: { method: 'GET', path: '/groups/second' } },
      ],
    } as never)
    .add({
      kind: 'playbook',
      id: 'test.tap-approved',
      title: 'Issue TAP (approved)',
      ...base,
      mode: 'write',
      inputs,
      steps: [
        { id: 'ok', type: 'approval' },
        { id: 'look', type: 'graph', mode: 'read', request: { method: 'GET', path: '/users/look' } },
        create,
      ],
    } as never)
    .add({
      kind: 'playbook',
      id: 'test.tap',
      title: 'Issue TAP',
      ...base,
      mode: 'write',
      inputs,
      steps: [create],
    } as never);
}

/** Microsoft's answers for the playbooks above; `hold` keeps calls to a path open until its gate opens. */
export function respond(hold: Record<string, Promise<void>> = {}) {
  return async (c: { method: string; path: string }) => {
    if (hold[c.path]) await hold[c.path];
    return c.method === 'POST' ? { id: 'm1', temporaryAccessPass: TAP, lifetimeInMinutes: 60 } : { id: 'x' };
  };
}
