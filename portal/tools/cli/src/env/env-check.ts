/**
 * The rules behind `adminforge env check`: compares an env file (overlaid by the process environment, as at run time)
 * with config/example.env and reports, per key, whether it is set, defaulted, missing or invalid — key names and
 * states only, never values.
 *
 * Inputs: the text of config/example.env, the parsed env-file values and the process env. Outputs: an `EnvReport`
 * (per-key states, unknown keys, readiness per purpose, warnings) and its terminal lines (`formatEnvReport`).
 * Readiness is decided per purpose — provision, portal, schedules, validation — from the REQUIRED lists below; a
 * `A|B` entry is satisfied by either key. Value checks reuse the provisioning rules (provision/ids.ts `isGuid`,
 * provision/settings.ts `originProblem`) so `env check` and `provision` never disagree.
 *
 * Pure (no files, no network): commands/env.ts reads the files and prints the result.
 */
import { parseEnv } from '@adminforge/config';
import { identityEnvPrefix, KQL_SOURCES } from '@adminforge/schemas';
import { isGuid } from '../provision/ids';
import { originProblem } from '../provision/settings';

/** The keys of a named app identity (AF_IDENTITY_<NAME>_…), documented once as a pattern in config/example.env. */
const IDENTITY_KEY_SUFFIXES = [
  'CLIENT_ID',
  'CLIENT_SECRET',
  'CERT_PATH',
  'ALLOW_WRITE_PERMISSIONS',
  'ALLOW_SENSITIVE_READS',
  'ALLOW_PRIVILEGED_PERMISSIONS',
];

/** What a key is needed for. A key is reported as required when any selected purpose needs it. */
export type Purpose = 'provision' | 'portal' | 'schedules' | 'validation';
export const PURPOSES: readonly Purpose[] = ['provision', 'portal', 'schedules', 'validation'];

export const REQUIRED: Record<Purpose, readonly string[]> = {
  provision: [
    'AF_TENANT_ID',
    'AF_PRIMARY_DOMAIN',
    'AF_PROVISIONER_CLIENT_ID',
    'AF_PROVISIONER_CLIENT_SECRET',
    'AF_ENV_LABEL',
    'PUBLIC_BASE_URL',
  ],
  portal: [
    'PUBLIC_BASE_URL',
    'AUTH_MODE',
    'DATA_MODE',
    'DATABASE_URL',
    'POSTGRES_PASSWORD',
    'TOKEN_CACHE_KEY',
    'AF_TENANT_ID',
    'AF_READ_CLIENT_ID',
    'AF_READ_CLIENT_SECRET',
    'AF_WRITE_CLIENT_ID',
    'AF_WRITE_CLIENT_SECRET',
    'RUNNER_URL',
    'RUNNER_SHARED_KEY',
  ],
  schedules: [
    'AF_TENANT_ID',
    'AF_AUTOMATION_CLIENT_ID',
    'AF_AUTOMATION_CLIENT_SECRET|AF_AUTOMATION_CERT_PATH',
  ],
  validation: ['AF_TENANT_ID', 'AF_PRIMARY_DOMAIN', 'AF_TEST_USER_UPN', 'AF_TEST_USER_PASSWORD'],
};

const GUID_KEYS = new Set([
  'AF_TENANT_ID',
  'AF_SUBSCRIPTION_ID',
  'AF_PROVISIONER_CLIENT_ID',
  'AF_READ_CLIENT_ID',
  'AF_WRITE_CLIENT_ID',
  'AF_AUTOMATION_CLIENT_ID',
]);

export type KeyState = 'set' | 'default' | 'missing' | 'invalid';

export interface KeyReport {
  key: string;
  state: KeyState;
  /** Where the value came from (never the value itself). */
  source?: 'file' | 'process';
  requiredFor: Purpose[];
  problem?: string;
}

export interface EnvReport {
  keys: KeyReport[];
  /** Keys in the env file that config/example.env does not document (likely typos). */
  unknown: string[];
  /** Per purpose: missing/invalid required keys (empty = ready). */
  readiness: Record<Purpose, string[]>;
  /** Settings that work but are weaker than they could be (key names only; never affects readiness). */
  warnings: string[];
}

function validate(key: string, value: string): string | undefined {
  if (GUID_KEYS.has(key) && !isGuid(value)) return 'expected a GUID';
  if (key === 'RUNNER_URL') {
    try {
      new URL(value);
    } catch {
      return 'expected a URL';
    }
  }
  // Origins that become Entra redirect URIs: https, or http on loopback only.
  if (key === 'PUBLIC_BASE_URL' || key === 'AF_REDIRECT_BASE_URLS') {
    const problem = value
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => originProblem(u))
      .find(Boolean);
    if (problem)
      return problem === 'is not a valid URL'
        ? 'expected a URL'
        : 'expected https (http only for localhost, 127.0.0.1 or ::1)';
  }
  // Permission-ceiling opt-ins are on only when exactly "true".
  if (/^AF_(AUTOMATION_)?ALLOW_/.test(key) && !['true', 'false'].includes(value))
    return 'expected true or false';
  if (key === 'TOKEN_CACHE_KEY' && Buffer.from(value, 'base64').length !== 32)
    return 'expected 32 random bytes, base64';
  if (key === 'AUTH_MODE' && !['entra', 'mock'].includes(value)) return 'expected entra or mock';
  if (key === 'DATA_MODE' && !['live', 'fixtures'].includes(value)) return 'expected live or fixtures';
  if (key === 'AF_ENV_LABEL' && !/^[a-z0-9][a-z0-9-]{0,19}$/.test(value))
    return 'expected lowercase letters, digits, dashes (max 20)';
  if (key === 'AF_QUERY_SOURCES') {
    const names = value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    // The API refuses an empty list at startup (apps/api/src/config.ts), which stops the worker and scheduler too.
    if (!names.length || !names.every((v) => (KQL_SOURCES as readonly string[]).includes(v)))
      return `expected ${KQL_SOURCES.join(', ')} (comma-separated, at least one)`;
  }
  if (key === 'DATABASE_URL' && value.includes('CHANGE_ME'))
    return 'still contains the CHANGE_ME placeholder';
  return undefined;
}

/**
 * Pure: checks env-file values (overlaid by process env, as at run time) against config/example.env.
 * Keys with a non-empty default in example.env count as "default" when absent. Values are never returned.
 */
export function checkEnv(
  exampleText: string,
  fileValues: Record<string, string>,
  processEnv: Record<string, string | undefined> = {},
): EnvReport {
  const example = parseEnv(exampleText);
  const keys: KeyReport[] = [];
  const byKey = new Map<string, KeyReport>();
  for (const [key, def] of Object.entries(example)) {
    const fromProcess = processEnv[key];
    const fromFile = fileValues[key];
    const value = fromProcess || fromFile;
    const requiredFor = PURPOSES.filter((p) => REQUIRED[p].some((r) => r.split('|').includes(key)));
    let report: KeyReport;
    if (value) {
      const problem = validate(key, value);
      report = {
        key,
        state: problem ? 'invalid' : 'set',
        source: fromProcess ? 'process' : 'file',
        requiredFor,
        problem,
      };
    } else if (def) report = { key, state: 'default', requiredFor, problem: validate(key, def) };
    else report = { key, state: 'missing', requiredFor };
    if (report.state === 'default' && report.problem) report.state = 'invalid';
    keys.push(report);
    byKey.set(key, report);
  }
  // A named app identity's keys (AF_IDENTITY_<NAME>_…, ADR-014) are documented once as a pattern, for each name listed
  // in AF_SCHEDULE_IDENTITIES.
  const identityPrefixes = (processEnv.AF_SCHEDULE_IDENTITIES ?? fileValues.AF_SCHEDULE_IDENTITIES ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .map(identityEnvPrefix);
  const identityKey = (k: string) =>
    identityPrefixes.some((p) => IDENTITY_KEY_SUFFIXES.some((s) => k === `${p}${s}`));
  const unknown = Object.keys(fileValues).filter((k) => !(k in example) && !identityKey(k));
  const ok = (k: string) => {
    const r = byKey.get(k);
    return !!r && (r.state === 'set' || r.state === 'default');
  };
  const readiness = Object.fromEntries(
    PURPOSES.map((p) => [
      p,
      REQUIRED[p].filter((alt) => !alt.split('|').some(ok)).map((alt) => alt.replace('|', ' or ')),
    ]),
  ) as Record<Purpose, string[]>;
  const warnings: string[] = [];
  // Without an authentication context, arming proves a fresh sign-in — which Entra may complete with a password alone.
  const authMode = processEnv.AUTH_MODE || fileValues.AUTH_MODE || example.AUTH_MODE;
  if (authMode !== 'mock' && !ok('WRITE_AUTH_CONTEXT') && 'WRITE_AUTH_CONTEXT' in example)
    warnings.push(
      'WRITE_AUTH_CONTEXT is not set: arming write access proves a fresh sign-in, not MFA. Set it to a Conditional Access authentication context that requires MFA (Entra ID P1).',
    );
  return { keys, unknown, readiness, warnings };
}

const LABEL: Record<KeyState, string> = {
  set: 'set',
  default: 'default',
  missing: 'missing',
  invalid: 'invalid',
};

/** Lines for the terminal: key names and states only. */
export function formatEnvReport(
  report: EnvReport,
  file: string,
  purposes: readonly Purpose[],
): { lines: string[]; ok: boolean } {
  const lines = [`Env file: ${file}`, ''];
  const width = Math.max(...report.keys.map((k) => k.key.length));
  for (const k of report.keys) {
    const required = k.requiredFor.length ? `required for ${k.requiredFor.join(', ')}` : 'optional';
    const extra = [k.source === 'process' ? 'from process env' : '', k.problem ?? '']
      .filter(Boolean)
      .join('; ');
    lines.push(
      `  ${k.key.padEnd(width)}  ${LABEL[k.state].padEnd(8)} ${required}${extra ? ` — ${extra}` : ''}`,
    );
  }
  if (report.unknown.length)
    lines.push('', `Not in config/example.env (typo?): ${report.unknown.join(', ')}`);
  if (report.warnings.length) lines.push('', 'Warnings:', ...report.warnings.map((w) => `  ! ${w}`));
  lines.push('', 'Readiness:');
  let ok = true;
  for (const p of PURPOSES) {
    const missing = report.readiness[p];
    const checked = purposes.includes(p);
    if (checked && missing.length) ok = false;
    lines.push(
      `  ${missing.length ? '✗' : '✓'} ${p.padEnd(10)} ${missing.length ? `missing/invalid: ${missing.join(', ')}` : 'ready'}${checked ? '' : ' (not checked)'}`,
    );
  }
  return { lines, ok };
}
