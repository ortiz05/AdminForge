import { checkEnv } from '@adminforge/cli/src/env/env-check';

// env check with the app-only credentials in HashiCorp Vault (ADR-018): Vault counts as the automation identity's
// credential, its address must be https (http on loopback only), and a credential left in the env file is named —
// the API refuses to start with both.
const EXAMPLE = `
AF_TENANT_ID=
AF_AUTOMATION_CLIENT_ID=
AF_AUTOMATION_CLIENT_SECRET=
AF_AUTOMATION_CERT_PATH=
AF_SCHEDULE_IDENTITIES=
AF_VAULT_ADDR=
`;
const base = {
  AF_TENANT_ID: '0f1e2d3c-4b5a-4968-8776-655443322110',
  AF_AUTOMATION_CLIENT_ID: '00000000-0000-4000-8000-0000000000a1',
};
const key = (r: ReturnType<typeof checkEnv>, k: string) => r.keys.find((x) => x.key === k);

describe('env check with Vault', () => {
  it('is ready for schedules with the credential in Vault, and names all three ways when none is set', () => {
    expect(
      checkEnv(EXAMPLE, { ...base, AF_VAULT_ADDR: 'https://vault.example.com' }).readiness.schedules,
    ).toEqual([]);
    expect(checkEnv(EXAMPLE, base).readiness.schedules).toEqual([
      'AF_AUTOMATION_CLIENT_SECRET or AF_AUTOMATION_CERT_PATH or AF_VAULT_ADDR',
    ]);
  });

  it('wants https for Vault, or http on loopback', () => {
    for (const addr of ['http://vault.example.com:8200', 'vault.example.com'])
      expect(key(checkEnv(EXAMPLE, { ...base, AF_VAULT_ADDR: addr }), 'AF_VAULT_ADDR')?.state, addr).toBe(
        'invalid',
      );
    expect(
      key(checkEnv(EXAMPLE, { ...base, AF_VAULT_ADDR: 'http://127.0.0.1:8200/' }), 'AF_VAULT_ADDR')?.state,
    ).toBe('set');
  });

  it('names a credential left in the env file, without its value', () => {
    const r = checkEnv(EXAMPLE, {
      ...base,
      AF_VAULT_ADDR: 'https://vault.example.com',
      AF_AUTOMATION_CLIENT_SECRET: 'synthetic-secret-value',
      AF_SCHEDULE_IDENTITIES: 'reports-team',
      AF_IDENTITY_REPORTS_TEAM_CLIENT_ID: '00000000-0000-4000-8000-0000000000d1',
      AF_IDENTITY_REPORTS_TEAM_CERT_PATH: '/etc/adminforge/reports-team.pem',
    });
    expect(key(r, 'AF_AUTOMATION_CLIENT_SECRET')).toMatchObject({
      state: 'invalid',
      problem: expect.stringContaining('comes from Vault'),
    });
    expect(r.warnings).toEqual([
      expect.stringMatching(/^AF_IDENTITY_REPORTS_TEAM_CERT_PATH is set, but with AF_VAULT_ADDR/),
    ]);
    expect(JSON.stringify(r)).not.toMatch(/synthetic-secret-value|reports-team\.pem/);
  });
});
