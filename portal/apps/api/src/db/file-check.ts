import { existsSync, realpathSync, statfsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * What the database file's location must not allow (ADR-016). SQLite has no roles: whoever can read the file reads
 * every hashed session id and sealed token; whoever can write it can rewrite history (the triggers stop the
 * application, not a person with access to the file). So the file and its -wal/-shm siblings must not be open to other
 * users, the directory must not let others replace them, and the file must be on a local filesystem — SQLite's locking
 * is unreliable on network filesystems (NFS, SMB/Azure Files, FUSE mounts such as blobfuse), which corrupts databases.
 */
export interface FileProblem {
  file: string;
  problem: string;
}

/** statfs f_type values of network and FUSE filesystems (linux/magic.h). */
const NETWORK_FILESYSTEMS = new Map<number, string>([
  [0x6969, 'NFS'],
  [0x517b, 'SMB'],
  [0xff534d42, 'SMB (CIFS)'],
  [0xfe534d42, 'SMB2'],
  [0x65735546, 'FUSE'],
  [0x00c36400, 'Ceph'],
  [0x01161970, 'GFS2'],
  [0x5346414f, 'AFS'],
  [0x7461636f, 'OCFS2'],
  [0x0bd00bd0, 'Lustre'],
]);

export interface FileCheckSeams {
  statfsType?: (dir: string) => number;
  uid?: () => number | undefined;
}

export function checkDatabaseFile(file: string, seams: FileCheckSeams = {}): FileProblem[] {
  if (file === ':memory:') return [];
  const out: FileProblem[] = [];
  if (!path.isAbsolute(file)) out.push({ file, problem: 'is not an absolute path' });
  // What the path really is: a symlink to another file system must not pass for the folder the link sits in.
  let target = path.resolve(file);
  try {
    target = realpathSync(target);
  } catch {
    try {
      target = path.join(realpathSync(path.dirname(target)), path.basename(target));
    } catch {
      // The folder doesn't exist: reported below.
    }
  }
  const dir = path.dirname(target);
  const uid = (seams.uid ?? (() => process.getuid?.()))();
  try {
    const d = statSync(dir);
    if (d.mode & 0o002)
      out.push({ file: dir, problem: 'is writable by other users (they could replace the database)' });
  } catch {
    out.push({ file: dir, problem: 'does not exist' });
    return out;
  }
  try {
    const type = (seams.statfsType ?? ((p: string) => Number(statfsSync(p).type)))(dir);
    const name = NETWORK_FILESYSTEMS.get(type);
    if (name)
      out.push({
        file: dir,
        problem: `is on a network filesystem (${name}); SQLite needs local block storage (a ReadWriteOnce disk such as Azure Disk), never NFS, SMB/Azure Files or FUSE`,
      });
  } catch {
    // statfs unavailable: nothing to report.
  }
  for (const f of [target, `${target}-wal`, `${target}-shm`]) {
    if (!existsSync(f)) continue;
    const s = statSync(f);
    if (s.mode & 0o007) out.push({ file: f, problem: 'can be read or written by other users (chmod 600)' });
    if (uid !== undefined && s.uid !== uid) out.push({ file: f, problem: 'is owned by another user' });
  }
  return out;
}

/**
 * Startup check (the API, before it creates or migrates anything — main.ts — and again when the app is ready):
 * production refuses to start on any problem above; development warns.
 */
export function assertDatabaseFile(
  file: string,
  opts: { production: boolean; warn: (msg: string) => void },
  seams?: FileCheckSeams,
): void {
  const problems = checkDatabaseFile(file, seams);
  if (!problems.length) return;
  const what = problems.map((p) => `${p.file} ${p.problem}`).join('; ');
  const msg = `The database in DATABASE_PATH is not safe to use: ${what} (docs/operations.md → Database).`;
  if (opts.production) throw new Error(msg);
  opts.warn(msg);
}
