import { ResourceGraphSpec, resourceGraphJoinProblem, startsWithUnion } from '@adminforge/schemas';

// (A wall-clock budget: `*.scale.test.ts` runs in the scale project, one file at a time.)
// The Resource Graph join/union lint runs on every Query Studio query (POST /api/query, any Reader) as well as in
// validate and the scaffold, on the API's one event loop. It must take linear time: before, 100,000 newlines took
// about 10 s (a comment pattern whose \s spanned lines) and 50,000 escaped quotes about 5 s (unclosed strings).
const ADVERSARIAL: Record<string, string> = {
  newlines: `a${'\n'.repeat(99_998)}a`,
  'spaces and newlines': ' \n'.repeat(50_000),
  'tabs and newlines': '\t\n'.repeat(50_000),
  'escaped single quotes': "'\\".repeat(50_000),
  'escaped double quotes': '"\\'.repeat(50_000),
  backslashes: `'${'\\'.repeat(99_999)}`,
  'unclosed quotes': "'".repeat(100_000),
  comments: '//\n'.repeat(33_000),
  pipes: '| '.repeat(50_000),
  'join options': '| join kind=x '.repeat(7_000),
  expressions: '${'.repeat(50_000),
};

describe('Resource Graph lint time', () => {
  it.each(Object.entries(ADVERSARIAL))(
    '%s (100,000 characters) is linted in well under a second',
    (_, query) => {
      const started = performance.now();
      ResourceGraphSpec.query.safeParse(query);
      resourceGraphJoinProblem(query);
      startsWithUnion(query);
      // The quadratic versions took 5–10 s; linear ones take a few milliseconds.
      expect(performance.now() - started).toBeLessThan(1_000);
    },
  );

  it('still reads strings, comments and leading unions as before', () => {
    expect(startsWithUnion('// a comment\n  union resources, resourcecontainers')).toBe(true);
    expect(startsWithUnion('resources | union (resourcecontainers)')).toBe(false);
    // A join inside a string or a comment is not an operation.
    const quoted = "resources | where name == 'x | join (a) | join (b) | join (c) | join (d)'";
    expect(resourceGraphJoinProblem(quoted)).toBeNull();
    const escaped = "resources | where name == 'it\\'s | join (a) | join (b) | join (c) | join (d)'";
    expect(resourceGraphJoinProblem(escaped)).toBeNull();
    const commented = 'resources\n// | join (a) | join (b) | join (c) | join (d)\n| project name';
    expect(resourceGraphJoinProblem(commented)).toBeNull();
    const four =
      'resources | join (resources) on id | join (resources) on id | join (resources) on id | join (resources) on id';
    expect(resourceGraphJoinProblem(four)).toMatch(/at most three/);
  });
});
