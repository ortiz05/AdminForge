import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkContent } from '@adminforge/cli/src/content/check';
import { usersWriteProblems } from '@adminforge/cli/src/content/lint';
import { loadContentDir } from '@adminforge/schemas';
import { repoRoot } from '../../lib/repo';

// S-15: the API refuses a declared Graph write that names a user by anything but an object id. `adminforge validate`
// says so first: in a write step (and in every compensation, which is always a write) the segment after `/users/` —
// in the path or in an `@odata.id` / `@odata.bind` reference in the body — must be `$guid(…)` (optionally inside
// `$encode(…)`) or a literal GUID.

const GUID = '00000000-0000-4000-8000-000000000102';
const step = (request: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'change',
  type: 'graph',
  mode: 'write',
  request: { method: 'PATCH', ...request },
  ...extra,
});
const paths = (def: unknown) => usersWriteProblems(def).map((p) => p.path);

describe('usersWriteProblems', () => {
  it('accepts $guid() (inside $encode or not), a literal GUID and the users collection', () => {
    for (const p of [
      '/users/${ $encode($guid(inputs.userId)) }',
      '/users/${ $guid(inputs.userId) }/revokeSignInSessions',
      `/users/${GUID}`,
      "/users('${ $guid(inputs.userId) }')",
      "${ '/users/' & $encode($guid(inputs.userId)) }",
      '/users',
    ])
      expect(paths({ steps: [step({ path: p })] }), p).toEqual([]);
  });

  it('flags a write path whose /users/ segment is not $guid()', () => {
    for (const p of [
      '/users/${ $encode(inputs.userId) }',
      '/users/${ $encode(steps.lookup.output.userPrincipalName) }/revokeSignInSessions',
      '/users/${ inputs.upn }',
      '/users/someone@example.com',
      "/users('${ $encode(inputs.upn) }')",
      "${ '/users/' & $encode(inputs.userId) }",
    ])
      expect(paths({ steps: [step({ path: p })] }), p).toEqual(['steps[0].request.path']);
  });

  it('flags @odata.id and @odata.bind references in a write body, in template and expression form', () => {
    const def = {
      steps: [
        step({
          method: 'POST',
          path: '/groups/${ $encode($guid(inputs.groupId)) }/members/$ref',
          body: { '@odata.id': 'https://graph.microsoft.com/v1.0/users/${ inputs.member }' },
        }),
        step({
          method: 'POST',
          path: '/groups',
          body: "${ { 'owners@odata.bind': [inputs.ownerIds.('https://graph.microsoft.com/v1.0/users/' & $)] } }",
        }),
        step({
          method: 'POST',
          path: '/groups',
          body: "${ { 'owners@odata.bind': [inputs.ownerIds.('https://graph.microsoft.com/v1.0/users/' & $guid($))] } }",
        }),
        step({
          method: 'PUT',
          path: '/users/${ $encode($guid(inputs.userId)) }/manager/$ref',
          body: { '@odata.id': 'https://graph.microsoft.com/v1.0/users/${ $guid(inputs.managerId) }' },
        }),
      ],
    };
    expect(paths(def)).toEqual(['steps[0].request.body["@odata.id"]', 'steps[1].request.body']);
  });

  it('checks compensations (always writes), nested forEach steps, runbook sections and changing batch requests', () => {
    const def = {
      sections: [
        {
          steps: [
            {
              id: 'create',
              type: 'graph',
              mode: 'write',
              request: { method: 'POST', path: '/users', body: {} },
              compensate: {
                type: 'graph',
                request: { method: 'DELETE', path: '/users/${ $encode(steps.create.output.id) }' },
              },
            },
            {
              id: 'each',
              type: 'forEach',
              items: '${ inputs.ids }',
              steps: [step({ path: '/users/${ $encode(item) }' })],
            },
            {
              id: 'batch',
              type: 'graphBatch',
              mode: 'write',
              requests: {
                read: { method: 'GET', path: '/users/${ $encode(inputs.upn) }' },
                change: { method: 'PATCH', path: '/users/${ $encode(inputs.upn) }', body: {} },
              },
            },
          ],
        },
      ],
    };
    expect(paths(def)).toEqual([
      'sections[0].steps[0].compensate.request.path',
      'sections[0].steps[1].steps[0].request.path',
      'sections[0].steps[2].requests.change.path',
    ]);
  });

  it('leaves reads alone: mode read steps, GET writes and datasources look users up by UPN', () => {
    const def = {
      datasources: { box: { source: 'graph', request: { path: '/users/${ $encode(params.upn) }' } } },
      steps: [
        { id: 'lookup', type: 'graph', mode: 'read', request: { path: '/users/${ $encode(inputs.upn) }' } },
        { id: 'lookup2', type: 'graph', request: { path: '/users/${ $encode(inputs.upn) }' } },
        step({ method: 'GET', path: '/users/${ $encode(inputs.upn) }' }),
      ],
    };
    expect(paths(def)).toEqual([]);
  });

  it('gives the segments to locate the line and says what to write instead', () => {
    const [p] = usersWriteProblems({ steps: [step({ path: '/users/${ $encode(inputs.userId) }' })] });
    expect(p!.segments).toEqual(['steps', 0, 'request', 'path']);
    expect(p!.message).toMatch(/\$guid\(\)/);
  });
});

describe('adminforge validate', () => {
  it('fails a playbook whose write names the user by UPN, at the line of the path', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'af-users-guid-'));
    try {
      const contentDir = path.join(root, 'content');
      const file = 'playbooks/identity/revoke-sessions.playbook.yaml';
      mkdirSync(path.dirname(path.join(contentDir, file)), { recursive: true });
      cpSync(
        path.join(repoRoot, 'portal', 'content', 'navigation.yaml'),
        path.join(contentDir, 'navigation.yaml'),
      );
      const shipped = readFileSync(path.join(repoRoot, 'portal', 'content', file), 'utf8');
      const marker = 'path: /users/${ $encode($guid(inputs.userId)) }/revokeSignInSessions';
      expect(shipped).toContain(marker);
      const yaml = shipped.replace(marker, 'path: /users/${ $encode(inputs.userId) }/revokeSignInSessions');
      writeFileSync(path.join(contentDir, file), yaml);
      const line = yaml.split('\n').findIndex((l) => l.includes('/users/${ $encode(inputs.userId) }')) + 1;
      const { errors } = await checkContent({ contentDir, repoRoot });
      expect(errors.filter((e) => e.includes('/users/'))).toEqual([
        expect.stringMatching(
          new RegExp(
            `^${file.replace(/\./g, '\\.')}:${line} steps\\[\\d+\\]\\.request\\.path: a write names a user`,
          ),
        ),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('shipped content', () => {
  it('names users by object id in every write', async () => {
    const { definitions } = await loadContentDir(path.join(repoRoot, 'portal', 'content'));
    const problems = definitions.flatMap((d) => usersWriteProblems(d.def).map((p) => `${d.file} ${p.path}`));
    expect(problems).toEqual([]);
  });
});
