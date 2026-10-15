import { randomUUID } from 'node:crypto';
import {
  buildDesiredIdentities,
  planIdentities,
  type IdentityState,
} from '@adminforge/cli/src/provision/identities-plan';

const desired = buildDesiredIdentities({ label: 'test', domain: 'example.com' });
const portalGroups = Object.fromEntries(
  desired.testerGroups.map((r) => [r, { id: randomUUID(), displayName: r }]),
);

const empty = (): IdentityState => ({
  testerGroupIds: [],
  testerRoleIds: [],
  portalGroups,
  targets: {},
  env: {},
});

function converged(): IdentityState {
  const testerId = randomUUID();
  return {
    tester: { id: testerId, userPrincipalName: desired.tester.upn },
    testerGroupIds: desired.testerGroups.map((r) => portalGroups[r]!.id),
    testerRoleIds: ['fe930be7-5e62-47db-91af-98c3a49a38b1', 'f2ef992c-3afb-46b9-b7cf-a126ee74c451'],
    portalGroups: { ...portalGroups },
    targets: Object.fromEntries(
      desired.targets.map((t) => [t.upn, { id: randomUUID(), userPrincipalName: t.upn }]),
    ),
    testGroup: { id: randomUUID(), displayName: 'AF-Test-Group-01' },
    testGroupOwnerIds: [testerId],
    env: { upn: desired.tester.upn, password: 'stored' },
  };
}

describe('buildDesiredIdentities', () => {
  it('defaults the tester UPN to af-tester@<domain> and names the AF-Test-* targets', () => {
    expect(desired.tester).toEqual({
      upn: 'af-tester@example.com',
      displayName: 'AF Tester',
      mailNickname: 'af-tester',
    });
    expect(desired.targets.map((t) => t.upn)).toEqual([
      'af-test-user-01@example.com',
      'af-test-user-02@example.com',
      'af-test-user-03@example.com',
    ]);
    expect(desired.testGroup.body).toMatchObject({
      displayName: 'AF-Test-Group-01',
      securityEnabled: true,
      mailEnabled: false,
    });
    expect(desired.testerRoles).toEqual(['User Administrator', 'Global Reader']);
  });

  it('honours an explicit AF_TEST_USER_UPN', () => {
    expect(
      buildDesiredIdentities({ label: 'x', domain: 'example.com', testerUpn: 'qa.bot@example.com' }).tester
        .mailNickname,
    ).toBe('qa.bot');
  });
});

describe('planIdentities', () => {
  it('creates everything in an empty tenant', () => {
    const ops = planIdentities(desired, empty());
    expect(ops.map((o) => o.action)).toEqual(Array(11).fill('create'));
  });

  it('is all no-op once converged', () => {
    expect(planIdentities(desired, converged()).every((o) => o.action === 'noop')).toBe(true);
  });

  it('resets the tester password when it is not in the env file', () => {
    const s = converged();
    s.env.password = undefined;
    expect(planIdentities(desired, s)[0]).toMatchObject({
      kind: 'tester',
      mode: 'resetPassword',
      action: 'update',
    });
  });

  it('adds a missing membership and role, and skips groups that provisioning has not created', () => {
    const s = converged();
    s.testerGroupIds = s.testerGroupIds.slice(1);
    s.testerRoleIds = s.testerRoleIds.slice(0, 1);
    delete s.portalGroups['Portal.Admin'];
    const ops = planIdentities(desired, s).filter((o) => o.action !== 'noop');
    expect(ops.map((o) => `${o.action} ${o.title}`)).toEqual([
      'create AF Tester ∈ SG-AdminForge-test-Portal.Reader',
      'skip AF Tester ∈ SG-AdminForge-test-Portal.Admin',
      'create AF Tester: Global Reader (directory scope /)',
    ]);
  });
});
