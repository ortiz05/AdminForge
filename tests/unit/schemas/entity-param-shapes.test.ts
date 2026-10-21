import { InvalidParams, resolveParams } from '@adminforge/api/src/datasources/params';
import { checkInputValue, checkParam, type Param, type Params } from '@adminforge/schemas';
import { coerceParam } from '@adminforge/web/src/renderer/params';

// L3 (whole-branch security review): validation lets a whole request path come from a single entity param (S-13:
// `type: user|group|device|app|resource|subscription` is "an id the server checked"), but page params of those types
// took any text up to 1,024 characters. They get the shape checks playbook inputs already had: a GUID (a GUID or a
// UPN for `user`), `/subscriptions/…` for `resource` — in the API and the browser alike.

const NOW = new Date('2026-10-21T12:00:00.000Z');
const scope = { now: NOW.toISOString(), user: { oid: 'u' }, env: {} };
const GUID = '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d';
const RESOURCE =
  '/subscriptions/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg-example/providers/Microsoft.Web/sites/app-1';

const PARAMS: Params = {
  user: { type: 'user' },
  group: { type: 'group' },
  device: { type: 'device' },
  app: { type: 'app' },
  resource: { type: 'resource' },
  subscription: { type: 'subscription' },
  groups: { type: 'group', multiple: true },
};

async function apiIssue(name: string, raw: unknown): Promise<string | undefined> {
  try {
    await resolveParams(PARAMS, { [name]: raw }, scope);
    return undefined;
  } catch (e) {
    if (!(e instanceof InvalidParams)) throw e;
    return e.issues.find((i) => i.param === name)?.message;
  }
}

describe('entity page params are the ids they name', () => {
  it.each<[string, unknown, string]>([
    ['user', 'avery', 'must be a user object id (GUID) or user principal name'],
    ['user', '/users/x/memberOf', 'must be a user object id (GUID) or user principal name'],
    ['group', '/groups', 'must be a group object id (GUID)'],
    ['device', 'laptop-7', 'must be a device object id (GUID)'],
    ['app', 'Contoso app', 'must be an app object id (GUID)'],
    [
      'resource',
      '/providers/Microsoft.Authorization/roleAssignments',
      'must be an Azure resource id (/subscriptions/…)',
    ],
    ['resource', 'subscriptions/x/resourceGroups/rg', 'must be an Azure resource id (/subscriptions/…)'],
    ['subscription', '/subscriptions/x', 'must be a subscription id (GUID)'],
    ['groups', [GUID, 'not-a-guid'], 'must be a group object id (GUID)'],
  ])('%s = %j is refused by the API and the page with the same words', async (name, raw, message) => {
    expect(await apiIssue(name, raw)).toBe(message);
    expect(checkParam(PARAMS[name]!, raw, NOW)).toEqual({ error: message });
    expect(coerceParam(PARAMS[name]!, raw, NOW)[1]).toBe(message);
  });

  it.each<[string, unknown, unknown]>([
    ['user', ` ${GUID} `, GUID],
    ['user', 'avery@example.com', 'avery@example.com'],
    ['group', GUID.toUpperCase(), GUID.toUpperCase()],
    ['device', GUID, GUID],
    ['app', GUID, GUID],
    ['resource', RESOURCE, RESOURCE],
    [
      'resource',
      '/SUBSCRIPTIONS/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg',
      '/SUBSCRIPTIONS/00000000-0000-4000-8000-0000000000a1/resourceGroups/rg',
    ],
    ['subscription', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1'],
    ['groups', [GUID, GUID], [GUID, GUID]],
  ])('%s = %j is accepted (trimmed, as before)', async (name, raw, value) => {
    expect(checkParam(PARAMS[name]!, raw, NOW)).toEqual({ value });
    expect(await apiIssue(name, raw)).toBeUndefined();
  });

  it('control characters and blanks still read "must be an id"', () => {
    expect(checkParam(PARAMS.user!, `${GUID}\t`, NOW)).toEqual({ error: 'must be an id' });
    expect(checkParam(PARAMS.resource!, ' ', NOW)).toEqual({ error: 'must be an id' });
  });

  it('playbook inputs keep their messages (the same rule, shared)', () => {
    const input = (type: string, v: unknown) => checkInputValue({ type } as Param, v, NOW);
    expect(input('group', 'x')).toEqual({ error: 'Expected a group object id (GUID).' });
    expect(input('user', 'avery')).toEqual({
      error: 'Expected a user object id (GUID) or user principal name.',
    });
    expect(input('resource', '/x')).toEqual({ error: 'Expected an Azure resource id (/subscriptions/…).' });
    expect(input('subscription', 'x')).toEqual({ error: 'Expected a subscription id (GUID).' });
    expect(input('app', GUID.toUpperCase())).toEqual({ value: GUID });
  });
});
