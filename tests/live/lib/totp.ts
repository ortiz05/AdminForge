import { createHmac } from 'node:crypto';

/** RFC 4648 base32 decode (authenticator-app secrets). */
export function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) — what Entra's "other authenticator app" option uses. */
export function totp(secretBase32: string, now = Date.now(), stepSeconds = 30, digits = 6): string {
  const counter = Math.floor(now / 1000 / stepSeconds);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString();
  return code.padStart(digits, '0');
}

/** Waits until a fresh code has at least `minSeconds` of validity left, then returns it. */
export async function freshTotp(secretBase32: string, minSeconds = 8): Promise<string> {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (left < minSeconds) await new Promise((r) => setTimeout(r, (left + 1) * 1000));
  return totp(secretBase32);
}
