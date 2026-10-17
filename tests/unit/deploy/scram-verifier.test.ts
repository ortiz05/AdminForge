import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { scramVerifier } from '../../../portal/deploy/db/scram.mjs';
import { repoRoot } from '../../lib/repo';

// portal/deploy/db/scram.mjs: SCRAM-SHA-256 verifiers computed client-side, so `pnpm db:harden` and create-app-role.sh
// never send a password to the server. The vector below is what PostgreSQL 18 itself stored for a synthetic password
// (CREATE ROLE … PASSWORD 'example-vector-pw-01'; SELECT rolpassword FROM pg_authid).
const PG_VERIFIER =
  'SCRAM-SHA-256$4096:mmfjCnjE5MlGSc1VC+fWZw==$TKPMyZReKF5lWEQBcBgcExXNI8bkP/BMmmmm3Gqe1C0=:YnrGTGFCWa9717ayvHZke3vCClOuZUP/2hQIBBJN69g=';

describe('scram.mjs', () => {
  it('computes the verifier PostgreSQL stores for the same password and salt', () => {
    const salt = Buffer.from('mmfjCnjE5MlGSc1VC+fWZw==', 'base64');
    expect(scramVerifier('example-vector-pw-01', { salt })).toBe(PG_VERIFIER);
  });

  it('uses a fresh 16-byte salt each time and refuses passwords it would have to normalise', () => {
    const a = scramVerifier('abcdef0123456789');
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(scramVerifier('abcdef0123456789')).not.toBe(a);
    expect(() => scramVerifier('short')).toThrow(/at least 8/);
    expect(() => scramVerifier('pässwörd-with-umlauts')).toThrow(/ASCII/);
  });

  it('reads the password from stdin when run as a script (never from the command line)', () => {
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'portal/deploy/db/scram.mjs')], {
      input: 'example-vector-pw-01\n',
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(r.stdout).not.toContain('example-vector-pw-01');
  });
});
