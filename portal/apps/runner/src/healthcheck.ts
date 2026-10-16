import { probeRunnerHealth } from './health-probe';

// Container HEALTHCHECK entry (Dockerfile: `node dist/healthcheck.js`): a signed GET /healthz against the local runner.
// Exit 0 when it answers 200, else 1. The logic and its configuration are in health-probe.ts.
process.exit(await probeRunnerHealth(process.env));
