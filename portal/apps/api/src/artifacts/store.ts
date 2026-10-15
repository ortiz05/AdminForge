import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

/**
 * Report files written by scheduled jobs: `<ADMINFORGE_ARTIFACTS_DIR>/<schedule key>/<timestamp>.<ext>`. Paths stored
 * on `schedule_runs.artifact_path` are relative to the directory; every read re-checks that the resolved real path
 * stays inside it (no `..`, no absolute paths, no symlinks out).
 */

export const ARTIFACT_TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json; charset=utf-8',
};

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9.-]*$/;
const SAFE_FILE = /^[0-9TZ-]+(-\d+)?\.(csv|xlsx|json)$/;

/** `2026-10-15T06:00:00.123Z` → `2026-10-15T06-00-00Z` (sortable, no colons). */
export const stamp = (at: Date) =>
  at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');

export interface WrittenArtifact {
  /** Relative to the artifacts directory. */
  path: string;
  name: string;
  size: number;
}

export interface OpenedArtifact {
  stream: Readable;
  size: number;
  name: string;
  contentType: string;
}

export class ArtifactStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }

  /** Creates `<schedule>/<timestamp>.<ext>` exclusively (a `-2`, `-3`… suffix if that second is taken) and lets `fill` write it. */
  async write(
    scheduleKey: string,
    at: Date,
    ext: 'csv' | 'xlsx' | 'json',
    fill: (out: Writable) => Promise<void>,
  ): Promise<WrittenArtifact> {
    if (!SAFE_SEGMENT.test(scheduleKey))
      throw new Error(`Unsafe schedule key for an artifact path: ${scheduleKey}`);
    const folder = path.join(this.dir, scheduleKey);
    await mkdir(folder, { recursive: true, mode: 0o750 });
    for (let n = 1; n < 100; n++) {
      const file = `${stamp(at)}${n > 1 ? `-${n}` : ''}.${ext}`;
      const abs = path.join(folder, file);
      let handle;
      try {
        handle = await open(abs, 'wx', 0o640);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      const out = handle.createWriteStream();
      try {
        await fill(out);
        if (!out.writableFinished)
          await new Promise<void>((resolve, reject) =>
            out.end((e?: Error | null) => (e ? reject(e) : resolve())),
          );
      } catch (err) {
        out.destroy();
        await rm(abs, { force: true });
        throw err;
      } finally {
        await handle.close().catch(() => undefined);
      }
      const { size } = await stat(abs);
      return { path: `${scheduleKey}/${file}`, name: `${scheduleKey}-${file}`, size };
    }
    throw new Error('Could not pick a unique artifact file name.');
  }

  /** Absolute path for a stored relative path, or null when it is not a well-formed artifact path inside the directory. */
  resolve(rel: string): string | null {
    const parts = rel.split('/');
    if (parts.length !== 2 || !SAFE_SEGMENT.test(parts[0]!) || !SAFE_FILE.test(parts[1]!)) return null;
    const abs = path.resolve(this.dir, parts[0]!, parts[1]!);
    return abs.startsWith(this.dir + path.sep) ? abs : null;
  }

  /** Opens a stored artifact for download; null when missing or outside the directory. */
  async open(rel: string): Promise<OpenedArtifact | null> {
    const abs = this.resolve(rel);
    if (!abs) return null;
    try {
      const [real, root] = await Promise.all([realpath(abs), realpath(this.dir)]);
      if (!real.startsWith(root + path.sep)) return null;
      const s = await stat(real);
      if (!s.isFile()) return null;
      const ext = path.extname(real).slice(1);
      return {
        stream: createReadStream(real),
        size: s.size,
        name: rel.replace('/', '-'),
        contentType: ARTIFACT_TYPES[ext] ?? 'application/octet-stream',
      };
    } catch {
      return null;
    }
  }

  async size(rel: string): Promise<number | null> {
    const abs = this.resolve(rel);
    if (!abs) return null;
    try {
      return (await stat(abs)).size;
    } catch {
      return null;
    }
  }

  /** Keeps the newest `keep` files of one extension for a schedule (names sort by time). Returns the deleted relative paths. */
  async prune(scheduleKey: string, ext: string, keep: number): Promise<string[]> {
    if (!SAFE_SEGMENT.test(scheduleKey)) return [];
    const folder = path.join(this.dir, scheduleKey);
    let names: string[];
    try {
      names = (await readdir(folder)).filter((n) => SAFE_FILE.test(n) && n.endsWith(`.${ext}`)).sort();
    } catch {
      return [];
    }
    const drop = names.slice(0, Math.max(names.length - keep, 0));
    for (const n of drop) await rm(path.join(folder, n), { force: true });
    return drop.map((n) => `${scheduleKey}/${n}`);
  }
}
