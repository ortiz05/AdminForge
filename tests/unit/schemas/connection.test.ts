import { type Connection } from '@adminforge/schemas';
import { brief, ENVELOPE, errors, ok } from './helpers';

const conn = (body: string) => `${ENVELOPE('connection', 'integrations.hr-sync')}${body}`;
const OPS = 'operations:\n  listEmployees: { path: /api/employees, mode: read }\n  syncEmployee: { method: POST, path: "/api/employees/{id}/sync", mode: write }\n  health: { path: /api/health, mode: read }\n';

describe('connection', () => {
  it('accepts env references for base URL and audience', () => {
    const def = ok<Connection>(conn(`baseUrl: "\${ env.AF_HR_SYNC_URL }"\naudience: "\${ env.AF_HR_SYNC_AUDIENCE }"\nhealth: health\n${OPS}`));
    expect(def.operations.listEmployees).toEqual({ method: 'GET', path: '/api/employees', mode: 'read' });
  });
  it('accepts literal https URLs, localhost and api:// audiences', () => {
    expect(ok(conn(`baseUrl: https://func-example.azurewebsites.net\naudience: api://func-example\n${OPS}`))).toBeTruthy();
    expect(ok(conn(`baseUrl: http://localhost:7071\naudience: 00000000-0000-4000-8000-000000000099\n${OPS}`))).toBeTruthy();
  });
  it.each([
    ['plain http', 'baseUrl: http://func.example.com\naudience: api://x\n' + OPS, 'baseUrl@6'],
    ['a write method marked read', 'baseUrl: https://x.example.com\naudience: api://x\noperations:\n  del: { method: DELETE, path: /api/x, mode: read }\n', 'operations.del.mode@9'],
    ['a query string in an operation path', 'baseUrl: https://x.example.com\naudience: api://x\noperations:\n  q: { path: "/api/x?a=1", mode: read }\n', 'operations.q.path@9'],
    ['an unknown health operation', 'baseUrl: https://x.example.com\naudience: api://x\nhealth: ping\n' + OPS, 'health@8'],
    ['no operations', 'baseUrl: https://x.example.com\naudience: api://x\noperations: {}\n', 'operations@8'],
    ['an operation without mode', 'baseUrl: https://x.example.com\naudience: api://x\noperations:\n  q: { path: /api/x }\n', 'operations.q.mode@9'],
  ])('rejects %s', (_label, body, at) => expect(brief(errors(conn(body)))).toEqual([at]));
});
