import { execFileSync } from 'node:child_process';
import { createHash, randomUUID, verify, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CliContext } from '@adminforge/cli/src/commands/context';
import { provisionEntra, provisionStatus } from '@adminforge/cli/src/commands/provision';
import { clientAssertion, parseCertificatePem } from '@adminforge/cli/src/provision/certificate';
import { createFakeCloud } from './fake-cloud';

// AF_AUTOMATION_CERT_PATH: provisioning registers the certificate on the automation app and removes its client
// secrets; status and the CLI authenticate with a signed client assertion. The key pair is generated per run (never
// committed) with openssl; the suite is skipped where openssl is missing.
const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let dir = '';
let pemPath = '';
let certOnlyPath = '';
beforeAll(() => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(path.join(tmpdir(), 'af-cert-'));
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
      '30',
      '-subj',
      '/CN=adminforge-test.example.com',
    ],
    { stdio: 'ignore' },
  );
  pemPath = path.join(dir, 'automation.pem');
  certOnlyPath = cert;
  writeFileSync(pemPath, readFileSync(cert, 'utf8') + readFileSync(key, 'utf8'), { mode: 0o600 });
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasOpenssl)('automation certificate (AF_AUTOMATION_CERT_PATH)', () => {
  it('parses the PEM bundle: DER, SHA-1 thumbprint, validity, private key', () => {
    const pem = readFileSync(pemPath, 'utf8');
    const c = parseCertificatePem(pem, { requireKey: true });
    const x509 = new X509Certificate(pem);
    expect(c.info.thumbprint).toBe(x509.fingerprint.replace(/:/g, ''));
    expect(Buffer.from(c.info.key, 'base64').equals(x509.raw)).toBe(true);
    expect(new Date(c.info.endDateTime).getTime()).toBeGreaterThan(Date.now());
    expect(c.privateKey).toBeDefined();
    expect(() => parseCertificatePem(readFileSync(certOnlyPath, 'utf8'), { requireKey: true })).toThrow(
      /private key/,
    );
    expect(() => parseCertificatePem('nothing here')).toThrow(/certificate/);
  });

  it('signs an RS256 client assertion for the token endpoint with x5t / x5t#S256 headers', () => {
    const pem = readFileSync(pemPath, 'utf8');
    const c = parseCertificatePem(pem, { requireKey: true });
    const clientId = randomUUID();
    const aud = `https://login.microsoftonline.com/${randomUUID()}/oauth2/v2.0/token`;
    const jwt = clientAssertion(c, { clientId, tokenEndpoint: aud });
    const [h, p, sig] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const der = new X509Certificate(pem).raw;
    expect(header).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      x5t: createHash('sha1').update(der).digest('base64url'),
      'x5t#S256': createHash('sha256').update(der).digest('base64url'),
    });
    expect(payload).toMatchObject({ aud, iss: clientId, sub: clientId });
    expect(payload.exp - payload.nbf).toBe(600);
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        new X509Certificate(pem).publicKey,
        Buffer.from(sig!, 'base64url'),
      ),
    ).toBe(true);
  });

  it('provision entra registers the certificate, removes the client secrets, and status uses the certificate', async () => {
    const tenant = randomUUID();
    const provisioner = { clientId: randomUUID(), secret: 'provisioner-secret' };
    const cloud = createFakeCloud({ tenantId: tenant, provisioner });
    const env: Record<string, string | undefined> = {
      AF_TENANT_ID: tenant,
      AF_PROVISIONER_CLIENT_ID: provisioner.clientId,
      AF_PROVISIONER_CLIENT_SECRET: provisioner.secret,
      AF_SUBSCRIPTION_ID: randomUUID(),
      AF_ENV_LABEL: 'test',
    };
    const lines: string[] = [];
    const ctx: CliContext = {
      env,
      writeEnv: (u) => Object.assign(env, u),
      out: (l) => lines.push(l),
      fetch: cloud.fetch,
      sleep: async () => {},
      contentScopes: {},
    };
    await provisionEntra(ctx); // secret mode first, like an existing installation
    const automation = () => cloud.apps.find((a) => a.uniqueName === 'adminforge-automation-test')!;
    expect(automation().passwordCredentials).toHaveLength(1);

    env.AF_AUTOMATION_CERT_PATH = pemPath;
    const dry = await provisionEntra(ctx, { dryRun: true });
    expect(
      dry.ops
        .filter(
          (o) =>
            'app' in o && o.app === 'automation' && o.section === 'Local credentials' && o.action !== 'noop',
        )
        .map((o) => `${o.action} ${o.kind}`),
    ).toEqual(['create keyCredential', 'delete removePassword']);
    expect(dry.ops.some((o) => o.kind === 'secret' && o.app === 'automation')).toBe(false);

    lines.length = 0;
    await provisionEntra(ctx);
    const thumbprint = parseCertificatePem(readFileSync(pemPath, 'utf8')).info.thumbprint;
    const keys = automation().keyCredentials as Array<{ customKeyIdentifier: string; type: string }>;
    expect(keys).toHaveLength(1);
    expect(Buffer.from(keys[0]!.customKeyIdentifier, 'base64').toString('hex').toUpperCase()).toBe(
      thumbprint,
    );
    expect(keys[0]!.type).toBe('AsymmetricX509Cert');
    expect(automation().passwordCredentials).toEqual([]);
    // Read and Write keep their secrets.
    expect(cloud.apps.filter((a) => (a.passwordCredentials as unknown[]).length === 1)).toHaveLength(2);
    expect((await provisionEntra(ctx)).ops.filter((o) => o.action !== 'noop' && o.action !== 'skip')).toEqual(
      [],
    );

    lines.length = 0;
    const status = await provisionStatus(ctx);
    const output = lines.join('\n');
    expect(output).toContain('certificate (AF_AUTOMATION_CERT_PATH) is accepted by Entra');
    expect(output).toContain('✓ AdminForge Automation [test]: credentials');
    expect(status.failures.filter((f) => /Automation/.test(f))).toEqual([]);
    expect(output).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE/);
  });
});
