import { validateExpressions } from '@adminforge/expressions';

// S-14 follow-up: content `pattern:`s are refused at validate time when they can backtrack without bound
// (`patternProblem` in @adminforge/schemas), but a regular expression written into an expression was not checked — and
// `$match(s, /(a+)+$/)` on 25 characters ran 609 ms, which no evaluation budget interrupts (a regex runs
// synchronously). `validateExpressions` (adminforge validate, publish, the content-health check) applies the same
// check to every regex literal, wherever it is used, with its `i` flag: a regex can only come from a literal in
// published content (data can't carry one, and `$eval` is off).

const issues = (expr: string) => validateExpressions({ datasources: { a: { transform: `\${ ${expr} }` } } });

describe('regular expressions in expressions at validate time', () => {
  it.each([
    ['$match(s, /(a+)+$/)', /repeats a group that itself repeats/],
    ['$match(s, /(a|a)*b/i)', /alternatives that can start alike/],
    ['s ~> $match(/\\d*\\d*x/)', /two repetitions that can match the same characters/],
    ['$match(?, /([a-z]+)*$/)', /repeats a group that itself repeats/],
    ['$map(items, function($v) { $match($v, /(\\w+\\s?)*$/) })', /repeats a group that itself repeats/],
    ['$match(s, /(a)\\1/)', /backreference/],
    // Every other way a regex is used.
    ['$contains(s, /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/)', /two repetitions/],
    ["$replace(s, /(a+)+$/, '')", /repeats a group/],
    ['$split(s, /(\\s|\\s)+/)', /alternatives that can start alike/],
    ['/(a+)+$/(s)', /repeats a group/],
    ['s ~> /(a+)+$/', /repeats a group/],
    ['$match(s, c ? /(a+)+$/ : /x/)', /repeats a group/],
    ['($m := $match; $m(s, /(a+)+$/))', /repeats a group/],
    ['($r := /(a+)+$/; $match(s, $r))', /repeats a group/],
    // Its flags: with `i`, `a` and `A` are the same character.
    ['$match(s, /(?:a|A)+$/i)', /alternatives that can start alike/],
    ['$contains(s, /[a-z]+[A-Z]*x/i)', /two repetitions that can match the same characters/],
  ])('refuses %s', (expr, problem) => {
    const found = issues(expr);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: 'datasources.a.transform', expression: expr });
    expect(found[0]!.message).toMatch(/^The regular expression \/.+\/: The pattern /);
    expect(found[0]!.message).toMatch(problem);
  });

  it.each([
    '$match(s, /^[A-Za-z0-9._-]+$/)',
    '$match(s, /([a-z0-9-]{1,63}\\.)+[a-z]{2,}/i)',
    '$match(s, /(?:Include|Exclude)+/)',
    "$match(s, /MC[0-9]{6}/).match ~> $join(', ')",
    '$contains(s, /[a-z]+[A-Z]*x/)',
    '$contains(s, /^[^\\s@]{1,64}@[^\\s@.]+(\\.[^\\s@.]+)+$/)',
    "$replace(s, /\\s*,\\s*/, ',')",
    '$match(s, $pattern)',
  ])('accepts %s', (expr) => {
    expect(issues(expr)).toEqual([]);
  });
});
