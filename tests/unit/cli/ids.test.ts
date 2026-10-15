import { appRoleId, armRoleAssignmentName, isGuid, uuidV5 } from '@adminforge/cli/src/provision/ids';

describe('deterministic ids', () => {
  it('implements RFC 4122 UUIDv5 (known vector)', () => {
    // DNS namespace + "www.example.com" is the textbook v5 example.
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('sets version 5 and the RFC variant', () => {
    const id = uuidV5('anything');
    expect(isGuid(id)).toBe(true);
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('gives the same app role id on every run, distinct per label and role', () => {
    expect(appRoleId('dev', 'Portal.Reader')).toBe(appRoleId('dev', 'Portal.Reader'));
    expect(appRoleId('dev', 'Portal.Reader')).not.toBe(appRoleId('prod', 'Portal.Reader'));
    expect(appRoleId('dev', 'Portal.Reader')).not.toBe(appRoleId('dev', 'Portal.Admin'));
  });

  it('derives Azure role assignment names from scope, role, and principal (case-insensitive)', () => {
    const a = armRoleAssignmentName('/subscriptions/ABC', 'Role', 'P1');
    expect(a).toBe(armRoleAssignmentName('/subscriptions/abc', 'role', 'p1'));
    expect(a).not.toBe(armRoleAssignmentName('/subscriptions/abc', 'role', 'p2'));
  });

  it('rejects a non-GUID namespace', () => expect(() => uuidV5('x', 'nope')).toThrow(/GUID/));
});
