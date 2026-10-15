import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appOnlyScope,
  certificateCredential,
  createAutomationTokenProvider,
  type ClientCredentialClient,
} from '@adminforge/api/src/auth/automation';

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT = '66666666-7777-4888-8999-000000000000';

function fakeMsal(
  impl?: (req: {
    scopes: string[];
    skipCache?: boolean;
    claims?: string;
  }) => Promise<{ accessToken: string } | null>,
) {
  const configs: Array<{ auth: Record<string, unknown> }> = [];
  const requests: Array<{ scopes: string[]; skipCache?: boolean; claims?: string }> = [];
  const createClient = (config: { auth: Record<string, unknown> }): ClientCredentialClient => {
    configs.push(config);
    return {
      acquireTokenByClientCredential: async (req) => {
        requests.push(req);
        return impl ? impl(req) : { accessToken: `app-token-${requests.length}` };
      },
    };
  };
  return { createClient: createClient as never, configs, requests };
}

let opensslAvailable = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  opensslAvailable = false;
}

describe('automation identity tokens (ADR-011)', () => {
  it('is null unless tenant, client id and a credential are configured', () => {
    expect(
      createAutomationTokenProvider({
        AF_TENANT_ID: TENANT,
        AF_AUTOMATION_CLIENT_ID: undefined,
        AF_AUTOMATION_CLIENT_SECRET: 's',
        AF_AUTOMATION_CERT_PATH: undefined,
      }),
    ).toBeNull();
    expect(
      createAutomationTokenProvider({
        AF_TENANT_ID: TENANT,
        AF_AUTOMATION_CLIENT_ID: CLIENT,
        AF_AUTOMATION_CLIENT_SECRET: undefined,
        AF_AUTOMATION_CERT_PATH: undefined,
      }),
    ).toBeNull();
  });

  it('secret: one MSAL client, client-credential tokens for <resource>/.default; forceRefresh and claims skip the cache', async () => {
    const msal = fakeMsal();
    const p = createAutomationTokenProvider(
      {
        AF_TENANT_ID: TENANT,
        AF_AUTOMATION_CLIENT_ID: CLIENT,
        AF_AUTOMATION_CLIENT_SECRET: 'synthetic-automation-secret',
        AF_AUTOMATION_CERT_PATH: undefined,
      },
      { createClient: msal.createClient },
    )!;
    expect(p.credential).toBe('secret');
    expect(await p.token('https://graph.microsoft.com/.default')).toBe('app-token-1');
    await p.token('https://management.azure.com/.default', { forceRefresh: true });
    await p.token('https://graph.microsoft.com/.default', { claims: '{"access_token":{}}' });
    expect(msal.configs).toHaveLength(1);
    expect(msal.configs[0]!.auth).toMatchObject({
      clientId: CLIENT,
      authority: `https://login.microsoftonline.com/${TENANT}`,
      clientSecret: 'synthetic-automation-secret',
    });
    expect(msal.requests).toEqual([
      { scopes: ['https://graph.microsoft.com/.default'] },
      { scopes: ['https://management.azure.com/.default'], skipCache: true },
      { scopes: ['https://graph.microsoft.com/.default'], skipCache: true, claims: '{"access_token":{}}' },
    ]);
    await expect(p.token('User.Read.All')).rejects.toThrow(/\.default/);
  });

  it('token failures name the AADSTS problem, never the credential', async () => {
    const msal = fakeMsal(async () => {
      throw Object.assign(new Error('x'), {
        errorMessage: 'AADSTS7000215: Invalid client secret provided.\nTrace ID: abc',
      });
    });
    const p = createAutomationTokenProvider(
      {
        AF_TENANT_ID: TENANT,
        AF_AUTOMATION_CLIENT_ID: CLIENT,
        AF_AUTOMATION_CLIENT_SECRET: 'synthetic-automation-secret',
        AF_AUTOMATION_CERT_PATH: undefined,
      },
      { createClient: msal.createClient },
    )!;
    const err = (await p.token('https://graph.microsoft.com/.default').catch((e: unknown) => e)) as Error & {
      code?: string;
    };
    expect(err).toMatchObject({ code: 'automation_token_failed', status: 502 });
    expect(err.message).toContain('AADSTS7000215');
    expect(err.message).not.toContain('Trace ID');
    expect(err.message).not.toContain('synthetic-automation-secret');
  });

  it.skipIf(!opensslAvailable)(
    'certificate (preferred): SHA-256 thumbprint, PKCS#8 key and x5c from one PEM file',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'af-cert-'));
      try {
        const key = path.join(dir, 'key.pem');
        const cert = path.join(dir, 'cert.pem');
        execFileSync(
          'openssl',
          [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-keyout',
            key,
            '-out',
            cert,
            '-days',
            '1',
            '-subj',
            '/CN=adminforge-test',
          ],
          { stdio: 'ignore' },
        );
        const pem = `${readFileSync(cert, 'utf8')}\n${readFileSync(key, 'utf8')}`;
        const cred = certificateCredential(pem);
        expect(cred.thumbprintSha256).toMatch(/^[0-9a-f]{64}$/);
        // (written as a pattern so this file never contains a literal PEM marker — the no-secrets guard)
        expect(cred.privateKey).toMatch(/^-{5}BEGIN PRIVATE KEY-{5}/);
        expect(cred.x5c).toMatch(/^[A-Za-z0-9+/=]+$/);

        const msal = fakeMsal();
        const p = createAutomationTokenProvider(
          {
            AF_TENANT_ID: TENANT,
            AF_AUTOMATION_CLIENT_ID: CLIENT,
            AF_AUTOMATION_CLIENT_SECRET: 'ignored-when-cert',
            AF_AUTOMATION_CERT_PATH: 'automation.pem',
          },
          { createClient: msal.createClient, readFile: () => pem },
        )!;
        expect(p.credential).toBe('certificate');
        await p.token('https://graph.microsoft.com/.default');
        expect(msal.configs[0]!.auth.clientCertificate).toMatchObject({
          thumbprintSha256: cred.thumbprintSha256,
        });
        expect(msal.configs[0]!.auth.clientSecret).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('a PEM without an unencrypted key is a configuration error', () => {
    expect(() =>
      certificateCredential('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'),
    ).toThrow(/unencrypted private key/);
  });

  it('appOnlyScope', () => {
    expect(appOnlyScope('api://00000000-0000-4000-8000-0000000000f1')).toBe(
      'api://00000000-0000-4000-8000-0000000000f1/.default',
    );
    expect(appOnlyScope('https://graph.microsoft.com/.default')).toBe('https://graph.microsoft.com/.default');
  });
});
