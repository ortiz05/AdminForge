import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envCheck, parsePurposes } from '@adminforge/cli/src/commands/env';
import { PURPOSES } from '@adminforge/cli/src/env/env-check';
import { ConfigError } from '@adminforge/cli/src/shared/errors';

// `adminforge env check`: reads the layered env files (never ~/.config here: ADMINFORGE_ENV_FILE points at a temp
// file), prints key names and states only, and decides the exit code from the purposes selected with --for.
describe('parsePurposes (--for)', () => {
  it('reads all, nothing, or a comma-separated list', () => {
    expect(parsePurposes(undefined)).toEqual([...PURPOSES]);
    expect(parsePurposes('all')).toEqual([...PURPOSES]);
    expect(parsePurposes(' provision, portal ,')).toEqual(['provision', 'portal']);
  });

  it('rejects unknown purposes with the valid ones', () => {
    expect(() => parsePurposes('provision,deploy')).toThrow(ConfigError);
    expect(() => parsePurposes('deploy')).toThrow(
      /Unknown purpose\(s\): deploy\. Use provision, portal, schedules, validation or all\./,
    );
  });
});

describe('adminforge env check', () => {
  const SECRET = `s3cret-${randomUUID()}`;
  const TENANT = randomUUID();

  function files(runtime: Record<string, string>, admin?: Record<string, string>) {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-env-'));
    const write = (file: string, values: Record<string, string>) =>
      writeFileSync(
        file,
        `${Object.entries(values)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')}\n`,
      );
    const file = path.join(dir, 'unit.env');
    write(file, runtime);
    if (admin) write(path.join(dir, 'unit.admin.env'), admin);
    const lines: string[] = [];
    return {
      file,
      lines,
      run: (purposes: string) =>
        envCheck((l) => lines.push(l), { for: purposes, env: { ADMINFORGE_ENV_FILE: file } }),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  const provisionKeys = {
    AF_TENANT_ID: TENANT,
    AF_PRIMARY_DOMAIN: 'unit.example.com',
    AF_ENV_LABEL: 'unit',
    PUBLIC_BASE_URL: 'https://portal.example.com',
  };
  const adminKeys = { AF_PROVISIONER_CLIENT_ID: randomUUID(), AF_PROVISIONER_CLIENT_SECRET: SECRET };

  it('is ready for provisioning with the admin keys in <env>.admin.env, and never prints a value', () => {
    const f = files(provisionKeys, adminKeys);
    try {
      expect(f.run('provision')).toBe(true);
      const text = f.lines.join('\n');
      expect(text).toContain(`Env file: ${f.file}`);
      expect(text).toMatch(/AF_PROVISIONER_CLIENT_SECRET\s+set\s+required for provision/);
      expect(text).toMatch(/✓ provision\s+ready/);
      for (const value of [SECRET, TENANT, adminKeys.AF_PROVISIONER_CLIENT_ID, 'unit.example.com'])
        expect(text).not.toContain(value);
      expect(text).not.toMatch(/^Move /m);
    } finally {
      f.cleanup();
    }
  });

  it('fails the selected purpose when a required key is missing or invalid', () => {
    const f = files({ ...provisionKeys, AF_TENANT_ID: 'not-a-guid' }, adminKeys);
    try {
      expect(f.run('provision')).toBe(false);
      expect(f.lines.join('\n')).toMatch(/✗ provision\s+missing\/invalid: AF_TENANT_ID/);
      expect(f.lines.join('\n')).toMatch(
        /AF_TENANT_ID\s+invalid\s+required for provision.* — expected a GUID/,
      );
    } finally {
      f.cleanup();
    }
  });

  it('decides the exit code only from the purposes selected', () => {
    const f = files(provisionKeys, adminKeys);
    try {
      // The portal needs keys this file lacks: shown as not ready, but not checked with --for provision.
      expect(f.run('provision')).toBe(true);
      expect(f.lines.join('\n')).toMatch(/✗ portal\s+missing\/invalid: .* \(not checked\)/);
      expect(f.run('portal')).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it('names unknown keys and admin keys that belong in the admin file', () => {
    const f = files({ ...provisionKeys, ...adminKeys, AF_TENANTID: 'typo-value-1234' });
    try {
      f.run('provision');
      const text = f.lines.join('\n');
      expect(text).toContain('Not in config/example.env (typo?): AF_TENANTID');
      expect(text).toContain(
        'Move AF_PROVISIONER_CLIENT_ID, AF_PROVISIONER_CLIENT_SECRET from unit.env to unit.admin.env (mode 600)',
      );
      expect(text).not.toContain('typo-value-1234');
      expect(text).not.toContain(SECRET);
    } finally {
      f.cleanup();
    }
  });

  it('says where the env file should be when it does not exist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'af-env-'));
    const lines: string[] = [];
    try {
      const file = path.join(dir, 'missing.env');
      expect(envCheck((l) => lines.push(l), { for: 'provision', env: { ADMINFORGE_ENV_FILE: file } })).toBe(
        false,
      );
      expect(lines[0]).toBe(`Env file not found: ${file} (copy config/example.env there and fill it in)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
