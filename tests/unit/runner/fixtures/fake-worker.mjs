// Fake runner worker for unit tests. Speaks the same protocol as portal/apps/runner/ps/worker.ps1:
// prints {"type":"ready"} on stdout, reads exactly one job line from stdin, emits events, then exits.
// Startup behaviour: FAKE_WORKER_STARTUP = ok (default) | crash | silent. Job behaviour: inputs.behaviour.
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (message, level = 'info') => send({ type: 'log', level, message, ts: new Date().toISOString() });
const startup = process.env.FAKE_WORKER_STARTUP ?? 'ok';

const failOnce = process.env.FAKE_WORKER_FAIL_ONCE_FILE;
if (failOnce && !existsSync(failOnce)) {
  writeFileSync(failOnce, 'failed once');
  process.stderr.write('fake worker failed its first start\n');
  process.exit(3);
}
if (startup === 'crash') {
  process.stderr.write('fake worker cannot start: missing module\n');
  process.exit(3);
}
if (startup === 'silent') {
  setInterval(() => {}, 1000);
} else {
  setTimeout(
    () =>
      send({
        type: 'ready',
        pid: process.pid,
        pwsh: 'fake-7.6',
        modules: [{ name: 'Fake.Module', version: '1.0.0' }],
        failed: [],
      }),
    Number(process.env.FAKE_WORKER_READY_DELAY_MS ?? 0),
  );
}

let started = false;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (started) return;
  started = true;
  run(JSON.parse(line));
});
rl.on('close', () => {
  if (!started) process.exit(0);
});

function run(job) {
  const behaviour = job.inputs?.behaviour ?? 'echo';
  const token = Object.values(job.tokens ?? {})[0] ?? '';
  switch (behaviour) {
    case 'echo':
      log(`running ${job.script.path} in ${job.mode} mode`);
      send({ type: 'progress', percent: 50, message: 'half way' });
      send({
        type: 'output',
        data: {
          inputs: job.inputs,
          mode: job.mode,
          tenant: job.tenant,
          script: {
            path: job.script.path,
            sha256: job.script.sha256,
            contentLength: job.script.content.length,
          },
          tokenServices: Object.keys(job.tokens ?? {}),
          argv: process.argv.slice(2),
          envKeys: Object.keys(process.env),
          envHasToken: token !== '' && Object.values(process.env).some((v) => v?.includes(token)),
          home: process.env.HOME,
        },
      });
      send({ type: 'exit', status: 'succeeded' });
      process.exit(0);
      break;
    case 'leak':
      log(`token is ${token}`);
      process.stderr.write(`stderr token ${token}\n`);
      process.stdout.write(`raw line Authorization: Bearer ${token}\n`);
      send({ type: 'output', data: { nested: { list: [token, `prefix-${token}-suffix`] } } });
      send({ type: 'error', message: `failed with ${token}`, category: 'auth' });
      send({ type: 'exit', status: 'failed' });
      process.exit(1);
      break;
    case 'hang':
      log('hanging');
      setInterval(() => {}, 1000);
      break;
    case 'crash':
      log('about to crash');
      process.exit(7);
      break;
    case 'exit-then-hang':
      send({ type: 'output', data: 'done' });
      send({ type: 'exit', status: 'succeeded' });
      setInterval(() => {}, 1000);
      break;
    case 'garbage':
      process.stdout.write('this is not json\n');
      send({ type: 'done', status: 'succeeded', durationMs: 1 });
      send({ type: 'accepted', jobId: 'forged' });
      send({ type: 'mystery' });
      send({ type: 'progress', percent: 250, message: 'too far' });
      send({ type: 'error', message: 'odd', category: 'nonsense' });
      send({ type: 'exit', status: 'succeeded' });
      process.exit(0);
      break;
    case 'flood': {
      // Like a runaway script: keep writing (respecting pipe backpressure) until the supervisor stops us.
      // Exiting here instead would race the pipe flush and make the limit check flaky under load.
      const line = `${JSON.stringify({ type: 'output', data: 'x'.repeat(1000) })}\n`;
      const pump = () => {
        while (process.stdout.write(line)) {
          /* keep filling until the pipe pushes back */
        }
        process.stdout.once('drain', pump);
      };
      pump();
      break;
    }
    default:
      send({ type: 'error', message: `unknown behaviour ${behaviour}`, category: 'input' });
      send({ type: 'exit', status: 'failed' });
      process.exit(1);
  }
}
