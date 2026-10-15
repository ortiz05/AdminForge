import { formatContentError, parseDefinition, validateDefinition } from '@adminforge/schemas';
import { brief, errors, ok, yaml } from './helpers';

const PB = yaml`
  kind: playbook
  id: identity.example
  version: 1.0.0
  title: Example
  owner: identity-team
  risk: low
  mode: read
  steps:
    - id: me
      type: graph
      request: { path: /me }
`;

describe('envelope', () => {
  it('accepts a minimal definition and applies defaults', () => {
    const def = ok(PB);
    expect(def).toMatchObject({ kind: 'playbook', id: 'identity.example', version: '1.0.0' });
    expect(def.kind === 'playbook' && def.steps[0]!.type === 'graph' && def.steps[0]!.request.method).toBe(
      'GET',
    );
  });
  it('allows $schema, summary, tags, status and requires', () =>
    expect(
      ok(
        `$schema: ../x.schema.json\n${PB}summary: Does a thing.\ntags: [a, b]\nstatus: preview\nrequires:\n  portalRoles: [Portal.Reader]\n  scopes: { graph: [User.Read.All], connections: { integrations.hr-sync: [user_impersonation] } }\n  entraRoles: [Directory Readers]\n  azureRoles: [Reader]\n  licences: [AAD_PREMIUM]\n`,
      ).requires?.licences,
    ).toEqual(['AAD_PREMIUM']));
  it.each([
    ['id: Identity.Example', 'id@2', /<section>\.<name>/],
    ['id: example', 'id@2', /<section>\.<name>/],
    ['version: "1.0"', 'version@3', /semver/],
    ['version: 1.0', 'version@3', /semver string/],
    ['title: ""', 'title@4', /expected string to have >=1/],
    ['status: published', 'status@24', /Invalid option/],
  ])('rejects %s', (line, at, message) => {
    const key = line.split(':')[0]!;
    const text =
      key === 'status'
        ? `${PB.trimEnd()}\n${'\n'.repeat(12)}${line}\n`
        : PB.replace(new RegExp(`^${key}: .*$`, 'm'), line);
    const e = errors(text);
    expect(brief(e)).toEqual([at]);
    expect(e[0]!.message).toMatch(message);
  });
  it('requires owner (points at the document)', () => {
    const e = errors(PB.replace('owner: identity-team\n', ''));
    expect(brief(e)).toEqual(['owner@1']);
  });
  it('points unknown keys at their own line', () => {
    const e = errors(PB.replace('owner: identity-team', 'owner: identity-team\nsumary: typo'));
    expect(e).toEqual([{ file: 'test.yaml', path: '', line: 6, message: 'Unrecognized key: "sumary"' }]);
  });
  it('points nested errors at the nested line', () => {
    const e = errors(PB.replace('request: { path: /me }', 'request:\n        path: me'));
    expect(brief(e)).toEqual(['steps[0].request.path@12']);
    expect(e[0]!.message).toMatch(/starting with \//);
  });
  it('rejects unknown portal roles', () =>
    expect(brief(errors(`${PB}requires:\n  portalRoles: [Portal.Superuser]\n`))).toEqual([
      'requires.portalRoles[0]@13',
    ]));
  it('names the allowed kinds', () => {
    const e = errors(PB.replace('kind: playbook', 'kind: widget'));
    expect(e).toEqual([
      {
        file: 'test.yaml',
        path: 'kind',
        line: 1,
        message: expect.stringMatching(/kind must be one of: page, dashboard, report, playbook/),
      },
    ]);
  });
  it('checks the file name suffix against kind', () =>
    expect(errors(PB, 'playbooks/identity/example.page.yaml')[0]!.message).toBe(
      'File name says page but kind is playbook.',
    ));
  it('reports YAML syntax errors with line and a quoting hint for expressions', () => {
    const e = errors(yaml`
      kind: page
      id: test.example
      status: \${ value > 0 ? 'warn' : 'ok' }
    `);
    expect(e[0]!.line).toBe(3);
    expect(e[0]!.message).toMatch(/^YAML: .*Quote values that contain \$\{ … \}/);
  });
  it('rejects duplicate keys', () =>
    expect(errors(`${PB}title: Again\n`)[0]!.message).toMatch(/YAML: Map keys must be unique/));
  it('rejects a document that is not a mapping', () =>
    expect(errors('- a\n- b\n')[0]!.message).toMatch(/Expected a mapping/));
  it('formats errors as file:line path: message', () =>
    expect(formatContentError({ file: 'a/b.page.yaml', line: 3, path: 'id', message: 'Bad' })).toBe(
      'a/b.page.yaml:3 id: Bad',
    ));
  it('validates plain objects without line numbers', () => {
    const r = validateDefinition({
      kind: 'navigation',
      id: 'portal.navigation',
      version: '1.0.0',
      title: 'Nav',
      owner: 'x',
      sections: [],
    });
    expect(r).toEqual({
      ok: false,
      errors: [
        { file: '<object>', path: 'sections', line: undefined, message: expect.stringMatching(/>=1 items/) },
      ],
    });
  });
  it('exposes a locate() for later checks', () => {
    const r = parseDefinition(PB, 'x.yaml');
    expect(r.ok && r.locate(['steps', 0, 'request', 'path'])).toBe(11);
    expect(r.ok && r.locate(['steps', 0, 'nope'])).toBe(9);
  });
});
