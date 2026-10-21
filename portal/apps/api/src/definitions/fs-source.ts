import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadContentDir, type ContentError, type Kind } from '@adminforge/schemas';
import {
  recordKey,
  type ChangeListener,
  type DefinitionRecord,
  type DefinitionsChanged,
  type DefinitionSource,
} from './types';

export interface FsSourceOptions {
  /** Reload when files under the directory change (development). */
  watch?: boolean;
  debounceMs?: number;
  /**
   * With `watch`: every this many ms, the YAML files' sizes, inodes and modification times are compared too, so a
   * change the file watcher misses still reloads (default 2000; 0 = off). Node's recursive watcher on Linux stops
   * reporting a file once it has been replaced by a rename — the way many editors, formatters and `sed -i` save.
   */
  pollMs?: number;
  log?: { info?(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  /** Tests: loads the directory (default loadContentDir). */
  loader?: typeof loadContentDir;
}

interface State {
  records: Map<string, DefinitionRecord>;
  /** file → record, to keep the last good version of a file that no longer validates. */
  byFile: Map<string, DefinitionRecord>;
  errors: ContentError[];
  /** The files' stamp (path, inode, size, mtime) taken before they were read; see `pollMs`. */
  stamp: string;
}

/**
 * Development source: `portal/content` on disk, validated with loadContentDir. With `watch`, edits reload within
 * ~150 ms (or by the next poll, `pollMs`, when the file watcher misses one) and listeners get the changed keys. A file that stops validating keeps serving its last good version
 * (its problems are reported through `problems()` and the log) so a typo doesn't make a page vanish mid-edit.
 */
export class FsDefinitionSource implements DefinitionSource {
  private state: State | null = null;
  private loading: Promise<State> | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private poller: NodeJS.Timeout | null = null;
  private polling = false;
  private reloading: Promise<DefinitionsChanged> | null = null;
  /** A reload asked for while one was running: it runs once more afterwards (it may have read a file too early). */
  private queued: Promise<DefinitionsChanged> | null = null;
  private readonly listeners = new Set<ChangeListener>();
  private closed = false;

  constructor(
    readonly dir: string,
    private readonly opts: FsSourceOptions = {},
  ) {}

  private async ensure(): Promise<State> {
    if (this.state) return this.state;
    this.loading ??= this.load(null).then((s) => {
      this.state = s;
      this.startWatching();
      return s;
    });
    return this.loading;
  }

  private async load(prev: State | null): Promise<State> {
    const stamp = this.opts.watch ? await this.stamp() : '';
    const { definitions, errors } = await (this.opts.loader ?? loadContentDir)(this.dir);
    const records = new Map<string, DefinitionRecord>();
    const byFile = new Map<string, DefinitionRecord>();
    const add = (r: DefinitionRecord) => {
      const k = recordKey(r.kind, r.key);
      if (!records.has(k)) records.set(k, r);
      if (r.file) byFile.set(r.file, r);
    };
    for (const d of definitions) {
      add({
        kind: d.def.kind,
        key: d.def.id,
        version: d.def.version,
        sha256: d.sha256,
        def: d.def,
        status: d.def.status === 'retired' ? 'retired' : 'published',
        source: 'fs',
        file: d.file,
      });
    }
    // Files that failed to parse keep their last good version.
    if (prev)
      for (const file of new Set(errors.map((e) => e.file)))
        if (!byFile.has(file) && prev.byFile.has(file)) add(prev.byFile.get(file)!);
    if (errors.length)
      this.opts.log?.warn(
        {
          problems: errors.length,
          first: errors
            .slice(0, 3)
            .map((e) => `${e.file}${e.line ? `:${e.line}` : ''} ${e.path}: ${e.message}`),
        },
        'content has problems',
      );
    return { records, byFile, errors, stamp };
  }

  /** Path, inode, size and modification time of every YAML file (cheap: no file is read). */
  private async stamp(): Promise<string> {
    const lines: string[] = [];
    const walk = async (abs: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(abs, { withFileTypes: true });
      } catch {
        return; // removed while walking
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(abs, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && /\.ya?ml$/i.test(e.name)) {
          const st = await stat(full).catch(() => null);
          if (st) lines.push(`${full}\t${st.ino}\t${st.size}\t${st.mtimeMs}`);
        }
      }
    };
    await walk(this.dir);
    return lines.sort().join('\n');
  }

  /** Debounced reload (watcher events and the poll). */
  private schedule() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.reload().catch((err) => this.opts.log?.warn({ err }, 'content reload failed')),
      this.opts.debounceMs ?? 150,
    );
    this.timer.unref?.();
  }

  private startWatching() {
    if (!this.opts.watch || this.watcher || this.closed) return;
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, filename) => {
        if (filename && !/\.ya?ml$/i.test(String(filename))) return;
        this.schedule();
      });
      this.watcher.on('error', (err) => this.opts.log?.warn({ err }, 'content watcher failed'));
      this.watcher.unref?.();
    } catch (err) {
      this.opts.log?.warn({ err }, 'cannot watch the content directory; changes are found by polling only');
    }
    const pollMs = this.opts.pollMs ?? 2000;
    if (pollMs > 0 && !this.poller) {
      this.poller = setInterval(() => void this.poll(), pollMs);
      this.poller.unref?.();
    }
  }

  /** Safety net for the watcher: reload when the files' stamp differs from the one the current state was read at. */
  private async poll() {
    if (this.polling || this.closed || !this.state || this.reloading) return;
    this.polling = true;
    try {
      const loadedAt = this.state.stamp;
      if ((await this.stamp()) !== loadedAt && this.state?.stamp === loadedAt) this.schedule();
    } catch (err) {
      this.opts.log?.warn({ err }, 'content poll failed');
    } finally {
      this.polling = false;
    }
  }

  /** Re-reads the directory and notifies listeners of changed keys (also called by the watcher and the poll). */
  async reload(): Promise<DefinitionsChanged> {
    if (this.reloading) {
      // A file changed while the running reload may already have read it: read once more when it ends.
      this.queued ??= this.reloading
        .catch(() => undefined)
        .then(() => {
          this.queued = null;
          return this.reload();
        });
      return this.queued;
    }
    this.reloading = (async () => {
      const prev = this.state ?? (await this.ensure());
      const next = await this.load(prev);
      const changed: string[] = [];
      for (const [k, r] of next.records) if (prev.records.get(k)?.sha256 !== r.sha256) changed.push(k);
      for (const k of prev.records.keys()) if (!next.records.has(k)) changed.push(k);
      this.state = next;
      const change = { keys: changed.sort() };
      if (changed.length) {
        this.opts.log?.info?.({ keys: changed.slice(0, 20), count: changed.length }, 'content reloaded');
        for (const l of this.listeners) l(change);
      }
      return change;
    })().finally(() => {
      this.reloading = null;
    });
    return this.reloading;
  }

  async list(kind?: Kind): Promise<DefinitionRecord[]> {
    const { records } = await this.ensure();
    return [...records.values()].filter((r) => r.status !== 'retired' && (!kind || r.kind === kind));
  }

  async get(kind: Kind, key: string, version?: string): Promise<DefinitionRecord | null> {
    const { records } = await this.ensure();
    const r = records.get(recordKey(kind, key));
    if (!r) return null;
    if (version) return r.version === version ? r : null;
    return r.status === 'retired' ? null : r;
  }

  /** The file's definition when it is retired (a file holds one version). */
  async retired(kind: Kind, key: string): Promise<DefinitionRecord | null> {
    const { records } = await this.ensure();
    const r = records.get(recordKey(kind, key));
    return r?.status === 'retired' ? r : null;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  problems(): ContentError[] {
    return this.state?.errors ?? [];
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }
}
