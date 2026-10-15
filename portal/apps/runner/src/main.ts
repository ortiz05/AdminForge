import { ConfigError, loadRunnerConfig } from './config';
import { buildRunnerServer } from './server';

async function main(): Promise<void> {
  let config;
  try {
    config = loadRunnerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`adminforge-runner: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const app = await buildRunnerServer({ config });
  const shutdown = (signal: string) => {
    app.log.info({ signal }, 'runner shutting down');
    void app.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      scriptsDir: config.scriptsDir,
      modulesDir: config.modulesDir,
      pwsh: config.pwshPath,
      poolSize: config.poolSize,
      maxJobs: config.maxJobs,
    },
    'runner ready',
  );
}

void main();
