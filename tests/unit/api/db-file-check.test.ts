import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertDatabaseFile, checkDatabaseFile } from '@adminforge/api/src/db/file-check';

// Where the database file lives must not let anyone else read or rewrite it, and must be local block storage: SQLite
// has no roles, and its locking is unreliable on network filesystems (ADR-016). Production refuses to start.
const EXT4 = 0xef53;
const NFS = 0x6969;
const SMB2 = 0xfe534d42;
const FUSE = 0x65735546;

function place(fileMode = 0o600, dirMode = 0o700) {
  const dir = mkdtempSync(path.join(tmpdir(), 'af-file-'));
  chmodSync(dir, dirMode);
  const file = path.join(dir, 'adminforge.db');
  writeFileSync(file, '');
  chmodSync(file, fileMode);
  return file;
}
const local = { statfsType: () => EXT4, uid: () => process.getuid!() };

describe('checkDatabaseFile', () => {
  it('accepts a private file on local storage, and in-memory databases', () => {
    expect(checkDatabaseFile(place(), local)).toEqual([]);
    expect(checkDatabaseFile(':memory:')).toEqual([]);
  });

  it('refuses a file other users can read or write, or that belongs to someone else', () => {
    const file = place(0o644);
    expect(checkDatabaseFile(file, local)).toEqual([
      { file, problem: 'can be read or written by other users (chmod 600)' },
    ]);
    expect(checkDatabaseFile(place(), { ...local, uid: () => 4242 })[0]?.problem).toBe(
      'is owned by another user',
    );
    // Group access is the pod's own fsGroup: allowed.
    expect(checkDatabaseFile(place(0o660), local)).toEqual([]);
  });

  it('refuses a folder others can write to (they could swap the file) and a relative path', () => {
    const file = place(0o600, 0o777);
    expect(checkDatabaseFile(file, local).map((p) => p.problem)).toEqual([
      'is writable by other users (they could replace the database)',
    ]);
    expect(checkDatabaseFile('state/adminforge.db', local)[0]?.problem).toBe('is not an absolute path');
  });

  it.each([
    [NFS, 'NFS'],
    [SMB2, 'SMB2'],
    [FUSE, 'FUSE'],
  ])('refuses a network or FUSE filesystem (statfs type %s: %s)', (type, name) => {
    const [problem] = checkDatabaseFile(place(), { ...local, statfsType: () => type });
    expect(problem?.problem).toMatch(
      new RegExp(`network filesystem \\(${name}\\).*ReadWriteOnce disk.*never NFS`),
    );
  });

  it('follows a symlink: the file system that counts is the one the file is really on', () => {
    const real = place(); // e.g. on an NFS mount
    const link = path.join(mkdtempSync(path.join(tmpdir(), 'af-link-')), 'adminforge.db');
    symlinkSync(real, link);
    const realDir = path.dirname(real);
    const [problem] = checkDatabaseFile(link, {
      ...local,
      statfsType: (dir) => (dir === realDir ? NFS : EXT4),
    });
    expect(problem).toMatchObject({
      file: realDir,
      problem: expect.stringMatching(/network filesystem \(NFS\)/),
    });
  });

  it('checks the -wal and -shm files too', () => {
    const file = place();
    writeFileSync(`${file}-wal`, '');
    chmodSync(`${file}-wal`, 0o666);
    expect(checkDatabaseFile(file, local).map((p) => p.file)).toEqual([`${file}-wal`]);
  });
});

describe('assertDatabaseFile', () => {
  it('refuses to start in production, warns in development, naming the file and the fix', () => {
    const file = place(0o644);
    expect(() => assertDatabaseFile(file, { production: true, warn: () => undefined }, local)).toThrow(
      /DATABASE_PATH is not safe to use: .*adminforge\.db can be read or written by other users/,
    );
    const warnings: string[] = [];
    assertDatabaseFile(file, { production: false, warn: (m) => warnings.push(m) }, local);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/docs\/operations\.md → Database/);
    assertDatabaseFile(place(), { production: true, warn: () => undefined }, local);
  });
});
