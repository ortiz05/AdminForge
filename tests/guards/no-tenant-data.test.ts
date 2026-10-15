import { committableFiles, localEnvFiles, parseEnvFile, readText } from '../lib/repo';

// Nothing tenant- or app-specific may be committed: configuration lives in ~/.config/adminforge/*.env.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['Entra client secret', /\b[A-Za-z0-9_\-.]{3,5}[78]Q~[A-Za-z0-9_\-.~]{30,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\bgh[opsu]_[A-Za-z0-9]{30,}/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['Azure storage key', /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/],
];

const files = committableFiles().filter((f) => f !== 'pnpm-lock.yaml');
const texts = files
  .map((f) => [f, readText(f)] as const)
  .filter((e): e is readonly [string, string] => e[1] !== undefined);

describe('no secrets are committed', () => {
  it.each(SECRET_PATTERNS)('%s', (_label, pattern) => {
    const hits = texts.filter(([, t]) => pattern.test(t)).map(([f]) => f);
    expect(hits).toEqual([]);
  });
});

describe('no tenant-specific values are committed', () => {
  const values = new Set<string>();
  for (const file of localEnvFiles()) {
    for (const [key, value] of Object.entries(parseEnvFile(file))) {
      // A bare loopback origin (RUNNER_URL=http://127.0.0.1:3101, the config/example.env default) isn't tenant data;
      // anything with a path still counts. Same rule as forbiddenValues in portal/tools/cli/src/commands/content.ts.
      if (
        value.length >= 8 &&
        !/^(true|false|\d+|https?:\/\/localhost(:\d+)?\/?|https?:\/\/127\.0\.0\.1(:\d+)?\/?|postgres:\/\/.*@127\.0\.0\.1.*)$/i.test(
          value,
        )
      )
        values.add(value);
      if (/DOMAIN/.test(key)) values.add(value.toLowerCase());
    }
  }
  it.skipIf(values.size === 0)('local configuration values do not appear in any committable file', () => {
    const hits: string[] = [];
    for (const [f, t] of texts) {
      const lower = t.toLowerCase();
      for (const v of values)
        if (lower.includes(v.toLowerCase())) hits.push(`${f} contains a value from local config`);
    }
    expect(hits).toEqual([]);
  });
});
