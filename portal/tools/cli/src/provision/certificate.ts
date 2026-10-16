/**
 * The automation identity's certificate (AF_AUTOMATION_CERT_PATH): parses the PEM bundle the API also uses
 * (certificate, optionally followed by its unencrypted private key) into the public part provisioning registers in
 * Entra (`CertificateInfo`: base64 DER, SHA-1 thumbprint, validity) and signs RFC 7523 client assertions with the
 * private key for the CLI's own token requests. Problems throw `CertificateError` (provision/settings.ts turns it into
 * a ConfigError); messages never contain key material.
 */
import { createHash, createPrivateKey, randomUUID, sign, X509Certificate, type KeyObject } from 'node:crypto';
import type { CertificateInfo } from './model';

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

/** A configuration problem with the certificate file; the message never contains key material. */
export class CertificateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CertificateError';
  }
}

export interface LoadedCertificate {
  info: CertificateInfo;
  /** SHA-256 thumbprint, base64url (JWT x5t#S256). */
  x5tS256: string;
  /** SHA-1 thumbprint, base64url (JWT x5t). */
  x5t: string;
  /** Present when the PEM also holds an unencrypted private key. */
  privateKey?: KeyObject;
}

/**
 * Parses AF_AUTOMATION_CERT_PATH's PEM bundle (certificate, optionally followed by its unencrypted private key —
 * the same file the API uses). Only the public part is registered in Entra.
 */
export function parseCertificatePem(pem: string, opts: { requireKey?: boolean } = {}): LoadedCertificate {
  const blocks = [...pem.matchAll(PEM_BLOCK)].map((m) => ({ label: m[1]!, text: m[0] }));
  const cert = blocks.find((b) => b.label === 'CERTIFICATE');
  const key = blocks.find((b) => /PRIVATE KEY$/.test(b.label) && !/ENCRYPTED/.test(b.label));
  if (!cert)
    throw new CertificateError('AF_AUTOMATION_CERT_PATH must be a PEM file that contains the certificate.');
  if (opts.requireKey && !key)
    throw new CertificateError(
      'AF_AUTOMATION_CERT_PATH must also contain the unencrypted private key (cat cert.pem key.pem > automation.pem).',
    );
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert.text);
  } catch {
    throw new CertificateError('AF_AUTOMATION_CERT_PATH does not hold a readable X.509 certificate.');
  }
  const der = x509.raw;
  const sha1 = createHash('sha1').update(der).digest();
  const sha256 = createHash('sha256').update(der).digest();
  let privateKey: KeyObject | undefined;
  if (key)
    try {
      privateKey = createPrivateKey(key.text);
    } catch {
      throw new CertificateError('The private key in AF_AUTOMATION_CERT_PATH could not be read.');
    }
  return {
    info: {
      key: der.toString('base64'),
      thumbprint: sha1.toString('hex').toUpperCase(),
      startDateTime: new Date(x509.validFrom).toISOString(),
      endDateTime: new Date(x509.validTo).toISOString(),
    },
    x5t: sha1.toString('base64url'),
    x5tS256: sha256.toString('base64url'),
    privateKey,
  };
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** RFC 7523 client assertion for the Entra token endpoint, signed with the certificate's private key (RS256). */
export function clientAssertion(
  cert: LoadedCertificate,
  opts: { clientId: string; tokenEndpoint: string; now?: number },
): string {
  if (!cert.privateKey) throw new CertificateError('AF_AUTOMATION_CERT_PATH has no private key.');
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const header = { alg: 'RS256', typ: 'JWT', x5t: cert.x5t, 'x5t#S256': cert.x5tS256 };
  const payload = {
    aud: opts.tokenEndpoint,
    iss: opts.clientId,
    sub: opts.clientId,
    jti: randomUUID(),
    nbf: now,
    iat: now,
    exp: now + 600,
  };
  const input = `${b64url(header)}.${b64url(payload)}`;
  return `${input}.${sign('sha256', Buffer.from(input), cert.privateKey).toString('base64url')}`;
}
