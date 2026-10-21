import { validateExpressions } from '@adminforge/expressions';

// S-14 follow-up: content `pattern:`s are refused at validate time when they can backtrack without bound
// (`patternProblem` in @adminforge/schemas), but a regular expression written into an expression for `$match` was not
// checked — and `$match(s, /(a+)+$/)` on 25 characters ran 609 ms, which no evaluation budget interrupts (a regex runs
// synchronously). `validateExpressions` (adminforge validate, publish, the content-health check) applies the same
// check to every regular expression handed to `$match`.

const issues = (expr: string) => validateExpressions({ datasources: { a: { transform: `\${ ${expr} }` } } });

describe('$match regular expressions at validate time', () => {
  it.each([
    ['$match(s, /(a+)+$/)', /repeats a group that itself repeats/],
    ['$match(s, /(a|a)*b/i)', /alternatives that can start alike/],
    ['s ~> $match(/\\d*\\d*x/)', /two repetitions that can match the same characters/],
    ['$match(?, /([a-z]+)*$/)', /repeats a group that itself repeats/],
    ['$map(items, function($v) { $match($v, /(\\w+\\s?)*$/) })', /repeats a group that itself repeats/],
    ['$match(s, /(a)\\1/)', /backreference/],
  ])('refuses %s', (expr, problem) => {
    const found = issues(expr);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'datasources.a.transform', expression: expr });
    expect(found[0]!.message).toMatch(/^\$match: The pattern /);
    expect(found[0]!.message).toMatch(problem);
  });

  it.each([
    '$match(s, /^[A-Za-z0-9._-]+$/)',
    '$match(s, /([a-z0-9-]{1,63}\\.)+[a-z]{2,}/i)',
    '$match(s, /(?:Include|Exclude)+/)',
    "$match(s, /MC[0-9]{6}/).match ~> $join(', ')",
    '$match(s, $pattern)',
  ])('accepts %s', (expr) => {
    expect(issues(expr)).toEqual([]);
  });
});
