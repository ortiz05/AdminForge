import type { ApiErrorBody, MeResponse, NavResponse } from '@adminforge/schemas';

/**
 * Hand-written guards for the responses the shell needs before anything else renders
 * (/api/me, /api/nav, error bodies). They keep zod out of the initial bundle; full zod
 * contracts from @adminforge/schemas are still used in lazily loaded routes and in tests.
 */
export class ContractError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';

function expect(cond: boolean, what: string): asserts cond {
  if (!cond) throw new ContractError(`Unexpected response: ${what}`);
}

export function parseApiError(data: unknown): ApiErrorBody | null {
  if (!isObject(data) || !isObject(data.error)) return null;
  const e = data.error;
  if (!isString(e.code) || !isString(e.message)) return null;
  return {
    error: {
      code: e.code,
      message: e.message,
      ...(isString(e.hint) ? { hint: e.hint } : {}),
      ...(isString(e.login) ? { login: e.login } : {}),
      ...(isObject(e.reauth) && isString(e.reauth.url) ? { reauth: { url: e.reauth.url } } : {}),
      ...(isString(e.correlationId) ? { correlationId: e.correlationId } : {}),
    },
  };
}

export const meContract = {
  parse(data: unknown): MeResponse {
    expect(isObject(data), 'me is not an object');
    const { user, tenant, roles, mode, armedUntil, csrf, prefs } = data;
    expect(isObject(user) && isString(user.oid) && isString(user.upn) && isString(user.name), 'me.user');
    expect(isObject(tenant) && isString(tenant.name) && isString(tenant.domain), 'me.tenant');
    expect(Array.isArray(roles) && roles.every(isString), 'me.roles');
    expect(mode === 'read' || mode === 'armed', 'me.mode');
    expect(armedUntil === null || isString(armedUntil), 'me.armedUntil');
    expect(isString(csrf), 'me.csrf');
    expect(prefs === undefined || isObject(prefs), 'me.prefs');
    expect(typeof data.canArm === 'boolean' && typeof data.armExtended === 'boolean', 'me.arm flags');
    expect(typeof data.armMaxMinutes === 'number', 'me.armMaxMinutes');
    expect(data.authMode === 'entra' || data.authMode === 'mock', 'me.authMode');
    expect(data.dataMode === 'live' || data.dataMode === 'fixtures', 'me.dataMode');
    return { ...(data as MeResponse), prefs: (prefs ?? {}) as MeResponse['prefs'] };
  },
};

export const navContract = {
  parse(data: unknown): NavResponse {
    expect(isObject(data) && Array.isArray(data.sections), 'nav.sections');
    for (const s of data.sections as unknown[]) {
      expect(
        isObject(s) && isString(s.key) && isString(s.label) && isString(s.icon) && Array.isArray(s.items),
        'nav.section',
      );
      for (const i of s.items as unknown[])
        expect(isObject(i) && isString(i.key) && isString(i.label) && isString(i.href), 'nav.item');
    }
    return data as NavResponse;
  },
};
