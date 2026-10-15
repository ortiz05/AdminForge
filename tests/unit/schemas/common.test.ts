import { DefinitionId, Duration, formatPath, parseDuration, SemVer } from '@adminforge/schemas';

describe('common building blocks', () => {
  it.each([
    ['PT4H', 4 * 3_600_000],
    ['P7D', 7 * 86_400_000],
    ['PT1M30S', 90_000],
    ['P1W', 7 * 86_400_000],
    ['PT0.5S', 500],
    ['500ms', 500],
    ['30s', 30_000],
    ['15m', 900_000],
    ['4h', 14_400_000],
    ['2d', 172_800_000],
  ])('parseDuration(%s)', (text, ms) => {
    expect(Duration.safeParse(text).success).toBe(true);
    expect(parseDuration(text)).toBe(ms);
  });
  it.each(['P', 'PT', '4 hours', '1y', 'T1H', ''])('rejects duration %j', (text) => {
    expect(Duration.safeParse(text).success).toBe(false);
    expect(() => parseDuration(text)).toThrow(/Invalid duration/);
  });
  it('accepts semver with prerelease and build', () => {
    for (const v of ['0.1.0', '1.2.3-beta.1', '1.0.0+sha.abc']) expect(SemVer.safeParse(v).success).toBe(true);
    for (const v of ['1.0', '01.0.0', 'v1.0.0']) expect(SemVer.safeParse(v).success).toBe(false);
  });
  it('accepts <section>.<name> ids (including local. drafts)', () => {
    for (const id of ['identity.users', 'local.identity.my-page', 'azure.function-apps']) expect(DefinitionId.safeParse(id).success).toBe(true);
    for (const id of ['users', 'Identity.users', 'identity.', 'identity.my_page']) expect(DefinitionId.safeParse(id).success).toBe(false);
  });
  it('formats paths', () => {
    expect(formatPath(['steps', 2, 'request', 'path'])).toBe('steps[2].request.path');
    expect(formatPath(['query', '$filter'])).toBe('query.$filter');
    expect(formatPath(['scopes', 'integrations.hr-sync'])).toBe('scopes["integrations.hr-sync"]');
    expect(formatPath([])).toBe('');
  });
});
