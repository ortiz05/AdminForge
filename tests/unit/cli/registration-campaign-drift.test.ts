import { randomUUID } from 'node:crypto';
import type { GraphClient } from '@adminforge/connectors';
import {
  campaignDrift,
  excludeFromRegistrationCampaign,
  removeFromRegistrationCampaignExclusions,
} from '@adminforge/cli/src/provision/identities-io';

// Graph replaces the authentication-methods registration campaign as a whole and has no ETag for it: provisioning
// reads it, adds (or removes) one test account and writes it all back. Someone editing the campaign in the Entra
// admin centre at the same moment loses their change, or provisioning loses its own. After the write, provisioning
// reads the campaign again and stops with what differs — names and counts, never ids — instead of carrying on as if
// all were well (S-22; test tenants only).
type Json = Record<string, unknown>;
const POLICY = '/policies/authenticationMethodsPolicy';

function campaign(excludes: Json[] = []): Json {
  return {
    state: 'default',
    snoozeDurationInDays: 1,
    includeTargets: [
      { id: 'all_users', targetType: 'group', targetedAuthenticationMethod: 'microsoftAuthenticator' },
    ],
    excludeTargets: excludes,
  };
}

/** A Graph stand-in holding the policy; `afterPatch` is "someone else" acting right after provisioning's write. */
function fakeGraph(
  initial: Json,
  opts: { afterPatch?: (stored: Json) => void; ignorePatch?: boolean; reshape?: (read: Json) => Json } = {},
) {
  let stored = structuredClone(initial);
  const calls: string[] = [];
  const graph = {
    request: async (req: { method?: string; path: string; body?: Json }) => {
      const method = req.method ?? 'GET';
      calls.push(`${method} ${req.path}`);
      if (req.path !== POLICY) throw new Error(`unexpected ${method} ${req.path}`);
      if (method === 'GET') {
        const read = structuredClone(stored);
        return {
          data: {
            '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#authenticationMethodsPolicy',
            registrationEnforcement: {
              authenticationMethodsRegistrationCampaign: opts.reshape?.(read) ?? read,
            },
          },
        };
      }
      const sent = (req.body?.registrationEnforcement as Json)
        .authenticationMethodsRegistrationCampaign as Json;
      if (!opts.ignorePatch) stored = structuredClone(sent);
      opts.afterPatch?.(stored);
      return { data: undefined };
    },
  };
  return { graph: graph as unknown as GraphClient, calls, stored: () => stored };
}

const errorOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a refusal');
};

describe('registration campaign: re-read after the write', () => {
  const user = randomUUID();

  it('adds the exclusion and confirms it with a second read', async () => {
    const other = { id: randomUUID(), targetType: 'group' };
    const g = fakeGraph(campaign([other]));
    await expect(excludeFromRegistrationCampaign(g.graph, user)).resolves.toBe('added');
    expect(g.calls).toEqual([`GET ${POLICY}`, `PATCH ${POLICY}`, `GET ${POLICY}`]);
    expect(g.stored().excludeTargets).toEqual([other, { id: user, targetType: 'user' }]);
  });

  it('takes Graph re-casing ids and adding annotations as no change', async () => {
    const g = fakeGraph(campaign(), {
      reshape: (read) => ({
        '@odata.type': '#microsoft.graph.authenticationMethodsRegistrationCampaign',
        ...read,
        excludeTargets: (read.excludeTargets as Json[]).map((t) => ({
          '@odata.type': '#microsoft.graph.excludeTarget',
          ...t,
          id: String(t.id).toUpperCase(),
        })),
      }),
    });
    await expect(excludeFromRegistrationCampaign(g.graph, user)).resolves.toBe('added');
  });

  it('stops when someone else changed the campaign at the same moment, naming what differs and never an id', async () => {
    const theirs = randomUUID();
    const g = fakeGraph(campaign(), {
      afterPatch: (stored) => {
        stored.state = 'enabled';
        (stored.excludeTargets as Json[]).push({ id: theirs, targetType: 'user' });
        stored.includeTargets = [];
      },
    });
    const err = await errorOf(excludeFromRegistrationCampaign(g.graph, user));
    expect(err.message).toMatch(/^The registration campaign is not what provisioning just wrote: /);
    expect(err.message).toContain('state');
    expect(err.message).toContain('targets (1 missing)');
    expect(err.message).toContain('other exclusions (1 added)');
    expect(err.message).toMatch(/Entra admin centre \(Authentication methods → Registration campaign\)/);
    expect(err.message).toMatch(/run provisioning again/);
    expect(err.message).not.toContain(user);
    expect(err.message).not.toContain(theirs);
    expect(err.message).not.toContain('all_users');
  });

  it("stops when the account's own exclusion did not take", async () => {
    const g = fakeGraph(campaign(), { ignorePatch: true });
    const err = await errorOf(excludeFromRegistrationCampaign(g.graph, user));
    expect(err.message).toContain("this account's exclusion is missing");
  });

  it('checks a removal the same way', async () => {
    const other = { id: randomUUID(), targetType: 'user' };
    const ok = fakeGraph(campaign([other, { id: user, targetType: 'user' }]));
    await expect(removeFromRegistrationCampaignExclusions(ok.graph, user)).resolves.toBe('removed');
    expect(ok.calls).toEqual([`GET ${POLICY}`, `PATCH ${POLICY}`, `GET ${POLICY}`]);
    expect(ok.stored().excludeTargets).toEqual([other]);

    const stuck = fakeGraph(campaign([{ id: user, targetType: 'user' }]), { ignorePatch: true });
    const err = await errorOf(removeFromRegistrationCampaignExclusions(stuck.graph, user));
    expect(err.message).toContain('this account is still excluded');
  });

  it('writes nothing, and reads once, when nothing needs to change', async () => {
    const g = fakeGraph(campaign([{ id: user.toUpperCase(), targetType: 'user' }]));
    await expect(excludeFromRegistrationCampaign(g.graph, user)).resolves.toBe('unchanged');
    expect(g.calls).toEqual([`GET ${POLICY}`]);
  });
});

describe('campaignDrift', () => {
  const user = randomUUID();
  const written = campaign([{ id: user, targetType: 'user' }]);

  it('is empty for the campaign as written', () => {
    expect(campaignDrift(written, structuredClone(written), { userId: user, excluded: true })).toEqual([]);
  });

  it('names changed settings, target and exclusion counts, and a campaign that is gone', () => {
    const read = { ...structuredClone(written), snoozeDurationInDays: 3, includeTargets: [] };
    expect(campaignDrift(written, read, { userId: user, excluded: true })).toEqual([
      'snoozeDurationInDays',
      'targets (1 missing)',
    ]);
    expect(campaignDrift(written, undefined, { userId: user, excluded: true })).toEqual([
      'the campaign itself (Graph returns none)',
    ]);
  });
});
