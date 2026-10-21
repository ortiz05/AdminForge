import { createDatabase, type Database } from '@adminforge/api/src/db/client';
import { SIGNAL_RETENTION_MS } from '@adminforge/api/src/db/signals';
import { testDatabasePath } from './db';

// Signals replace LISTEN/NOTIFY (ADR-016): a publish reaches this process's listeners at once and other processes on
// the same file at their next poll — the CLI's `publish` telling the running API to drop cached definitions, a
// scheduler one-shot's probe results reaching browsers. Polls are driven by hand here (no timers).
describe('signals between processes (SQLite)', () => {
  let file: string;
  let api: Database;
  let cli: Database;
  const manual = { setInterval: () => 0, clearInterval: () => undefined };

  beforeEach(async () => {
    file = await testDatabasePath();
    // Hand-driven polling for both (the default timer would race the assertions).
    api = createDatabase(file, { name: 'api', signalTimers: manual });
    cli = createDatabase(file, { name: 'cli', signalTimers: manual });
  });
  afterEach(async () => {
    await api.close();
    await cli.close();
  });

  it('delivers in-process at once and to the other process on its next poll — never back to the sender', () => {
    const seenApi: string[] = [];
    const seenCli: string[] = [];
    api.signals.on('definitions_changed', (p) => seenApi.push(p));
    cli.signals.on('definitions_changed', (p) => seenCli.push(p));
    cli.signals.publish('definitions_changed', '{"keys":["page:identity.users"]}');
    expect(seenCli).toEqual(['{"keys":["page:identity.users"]}']);
    expect(seenApi).toEqual([]);
    api.signals.poll();
    expect(seenApi).toEqual(['{"keys":["page:identity.users"]}']);
    cli.signals.poll();
    expect(seenCli).toHaveLength(1);
    // Nothing new: the next poll reads nothing (data_version unchanged).
    api.signals.poll();
    expect(seenApi).toHaveLength(1);
  });

  it('only delivers the channel a listener asked for; local: false skips the in-process copy', () => {
    const got: string[] = [];
    api.signals.on('schedule_events', (p) => got.push(`schedule:${p}`));
    cli.signals.on('schedule_events', (p) => got.push(`cli:${p}`));
    cli.signals.publish('run_other', 'x');
    cli.signals.publish('schedule_events', 'a', { local: false });
    api.signals.poll();
    expect(got).toEqual(['schedule:a']);
  });

  it('starts at the end of the table: history is not replayed to a process that starts later', async () => {
    cli.signals.publish('definitions_changed', 'old');
    const late = createDatabase(file, { name: 'late', signalTimers: manual });
    try {
      const got: string[] = [];
      late.signals.on('definitions_changed', (p) => got.push(p));
      late.signals.poll();
      expect(got).toEqual([]);
      cli.signals.publish('definitions_changed', 'new');
      late.signals.poll();
      expect(got).toEqual(['new']);
    } finally {
      await late.close();
    }
  });

  it('a process that missed pruned signals is told to resync (drop caches), like a LISTEN reconnect', () => {
    const resyncs: number[] = [];
    api.signals.on('definitions_changed', () => undefined);
    api.signals.onResync(() => resyncs.push(1));
    cli.signals.publish('definitions_changed', 'one');
    api.signals.poll();
    cli.signals.publish('definitions_changed', 'two');
    cli.signals.publish('definitions_changed', 'three');
    // The API was paused for over an hour: both rows were pruned before it read them.
    const later = new Date(Date.now() + SIGNAL_RETENTION_MS + 60_000);
    expect(cli.signals.prune(later)).toBeGreaterThanOrEqual(2);
    cli.signals.publish('definitions_changed', 'four');
    api.signals.poll();
    expect(resyncs).toEqual([1]);
  });

  it('refuses channel names that are not plain identifiers', () => {
    expect(() => api.signals.publish('bad channel', 'x')).toThrow(/Invalid channel name/);
    expect(() => api.signals.on('x;drop', () => undefined)).toThrow(/Invalid channel name/);
  });
});
