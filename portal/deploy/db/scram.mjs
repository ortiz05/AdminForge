#!/usr/bin/env node
/**
 * SCRAM-SHA-256 password verifiers computed on this side (RFC 5802 / RFC 7677, PostgreSQL's stored format), so a role's
 * password never reaches the server: `CREATE/ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'` stores the verifier as given.
 * Statement logging (log_statement=ddl), pg_stat_statements or an error report can then only ever show the verifier —
 * which, for the random 256-bit passwords AdminForge generates, can't be turned back into a password.
 *
 *   import { scramVerifier } from './scram.mjs';                 // portal/deploy/db/harden-postgres.ts
 *   printf '%s' "$PASSWORD" | node portal/deploy/db/scram.mjs    // portal/deploy/db/create-app-role.sh (stdin, never argv)
 *
 * Passwords here are ASCII (hex or base64url), for which SASLprep changes nothing; others are refused.
 * Tested against PostgreSQL's own verifier in tests/unit/deploy/scram-verifier.test.ts.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRAM_ITERATIONS = 4096;

/** `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>` (base64), PostgreSQL's pg_authid.rolpassword format. */
export function scramVerifier(password, { salt = randomBytes(16), iterations = SCRAM_ITERATIONS } = {}) {
  if (typeof password !== 'string' || !/^[\x21-\x7e]{8,}$/.test(password))
    throw new Error('expected a printable ASCII password of at least 8 characters');
  const salted = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  process.stdout.write(`${scramVerifier(password)}\n`);
}
