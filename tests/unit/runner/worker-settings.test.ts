import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RUNNER_ROOT,
  WORKER_SETTINGS_FILE,
  buildWorkerCommand,
  findPwsh,
  loadRunnerConfig,
  workerSettingsFile,
} from '@adminforge/runner/src/config';
import { newKey } from './helpers';

// Workers start with ps/powershell.config.json instead of the system-wide settings: PowerShell's script-block
// auto-logging (module source at warning priority) and informational events (some with parameter values) stay out
// of the journal; warnings and errors still reach it.
const settingsPath = path.join(RUNNER_ROOT, 'ps', WORKER_SETTINGS_FILE);

describe('runner worker settings', () => {
  it('passes the settings file before -File (pwsh hands everything after -File to the script)', () => {
    const config = loadRunnerConfig({ RUNNER_SHARED_KEY: newKey(), PWSH_PATH: '/opt/pwsh/pwsh' });
    const { args } = buildWorkerCommand(config, { PATH: '/usr/bin' });
    expect(workerSettingsFile(config)).toBe(settingsPath);
    const at = args.indexOf('-SettingsFile');
    expect(at).toBeGreaterThan(-1);
    expect(args[at + 1]).toBe(settingsPath);
    expect(at).toBeLessThan(args.indexOf('-File'));
    expect(args.slice(-2)).toEqual(['-File', config.workerScript]);
  });

  it('ships next to worker.ps1 (the runner image copies ps/) and turns the logging down', () => {
    expect(existsSync(settingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      LogLevel: 'Warning',
      PowerShellPolicies: {
        ScriptBlockLogging: { EnableScriptBlockLogging: false, EnableScriptBlockInvocationLogging: false },
        ModuleLogging: { EnableModuleLogging: false },
        Transcription: { EnableTranscripting: false },
      },
    });
    expect(readFileSync(path.join(RUNNER_ROOT, 'Dockerfile'), 'utf8')).toMatch(
      /^COPY portal\/apps\/runner\/ps \.\/ps$/m,
    );
  });

  const pwsh = findPwsh();
  const hasPwsh =
    spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;

  // What PowerShell itself applies (its configuration class is internal: read through reflection, test-only).
  const EFFECTIVE = `
$flags = [Reflection.BindingFlags]'NonPublic,Public,Static,Instance'
$t = [psobject].Assembly.GetType('System.Management.Automation.Configuration.PowerShellConfig')
$i = $t.GetField('Instance', $flags).GetValue($null)
$scope = [psobject].Assembly.GetType('System.Management.Automation.Configuration.ConfigScope')
$policies = $t.GetMethod('GetPowerShellPolicies', $flags).Invoke($i, @([Enum]::Parse($scope, 'AllUsers')))
[ordered]@{
  logLevel = "$($t.GetMethod('GetLogLevel', $flags).Invoke($i, @()))"
  scriptBlockLogging = $policies.ScriptBlockLogging.EnableScriptBlockLogging
} | ConvertTo-Json -Compress`;

  it.skipIf(!hasPwsh)('is what pwsh applies when a worker starts', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'af-pwsh-settings-'));
    try {
      const run = (extra: string[]) =>
        spawnSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', ...extra, '-Command', EFFECTIVE], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, HOME: home, POWERSHELL_TELEMETRY_OPTOUT: '1' },
        });
      const withFile = run(['-SettingsFile', settingsPath]);
      expect(withFile.status).toBe(0);
      expect(JSON.parse(withFile.stdout)).toEqual({ logLevel: 'Warning', scriptBlockLogging: false });
      // Without it, suspicious script blocks are auto-logged (policy unset) and informational events too.
      expect(JSON.parse(run([]).stdout)).toEqual({ logLevel: 'Informational', scriptBlockLogging: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
