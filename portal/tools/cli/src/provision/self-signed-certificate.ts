/**
 * A throwaway self-signed X.509 certificate (RSA 2048, SHA-256), built in memory for the `apps` test fixture: Entra
 * needs a real certificate to show a certificate credential and its expiry. The private key never leaves this
 * function — it signs the certificate and is dropped; nothing is written to disk. Only the public certificate (DER) is
 * returned. Minimal DER encoding of RFC 5280 (v3, no extensions), no dependency.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const length = (n: number) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, content: Buffer) =>
  Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));
const integer = (bytes: Buffer) =>
  tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const chunk: number[] = [];
    for (let v = n; ; v >>= 7) {
      chunk.unshift((v & 0x7f) | (chunk.length ? 0x80 : 0));
      if (v < 0x80) break;
    }
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
/** UTCTime (dates before 2050), YYMMDDHHMMSSZ. */
const utcTime = (d: Date) =>
  tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));

const SHA256_WITH_RSA = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));
const commonName = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));

/** A self-signed certificate valid from `notBefore` to `notAfter` (public part only, DER). */
export function selfSignedCertificate(cn: string, notBefore: Date, notAfter: Date): Buffer {
  if (notAfter.getUTCFullYear() >= 2050)
    throw new Error('certificate end dates from 2050 need GeneralizedTime');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // Positive (top bit clear) and minimal DER (first byte never 0): 0x40–0x7f.
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x3f) | 0x40;
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    SHA256_WITH_RSA,
    commonName(cn),
    seq(utcTime(notBefore), utcTime(notAfter)),
    commonName(cn),
    spki,
  );
  const signature = sign('sha256', tbs, privateKey);
  return seq(tbs, SHA256_WITH_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}
