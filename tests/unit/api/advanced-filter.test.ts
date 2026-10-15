import { AdvancedFilterError, compileAdvanced, decodeAdvanced, describeAdvanced, kqlString, MAX_CONDITIONS, odataString, parseAdvanced } from '@adminforge/api/src/datasources/advanced';
import { parseDefinition, type FilterBar } from '@adminforge/schemas';

type Spec = NonNullable<FilterBar['advanced']>;
const NOW = new Date('2026-10-15T12:00:00.000Z');

const FIELDS: Spec['fields'] = [
  { field: 'department', label: 'Department', type: 'string', operators: ['eq', 'ne', 'startsWith', 'contains', 'in', 'isEmpty'] },
  { field: 'created', label: 'Created', type: 'date', property: 'createdDateTime', operators: ['ge', 'le', 'eq'] },
  { field: 'seats', label: 'Seats', type: 'number', operators: ['eq', 'gt', 'ge', 'lt', 'le', 'in'] },
  { field: 'enabled', label: 'Enabled', type: 'boolean', property: 'accountEnabled' },
  { field: 'owner', label: 'Owner', type: 'guid' },
  { field: 'kind', label: 'Kind', type: 'enum', values: ['Member', 'Guest'] },
  { field: 'state', label: 'State', type: 'string', property: 'properties.provisioningState', operators: ['eq'] },
];
const odata: Spec = { dialect: 'odata', fields: FIELDS.filter((f) => f.field !== 'state') };
const kql: Spec = { dialect: 'kql', fields: FIELDS.map((f) => (f.field === 'created' ? { ...f, property: 'createdTime' } : f)) };

const compile = (spec: Spec, raw: unknown) => {
  const g = parseAdvanced(spec, raw, NOW);
  return g ? compileAdvanced(g, spec.dialect === 'kql' ? 'kql' : 'odata') : undefined;
};
const one = (field: string, op: string, value?: unknown) => ({ all: [{ field, op, ...(value !== undefined ? { value } : {}) }] });
const rejects = (spec: Spec, raw: unknown, pattern: RegExp) => {
  let err: unknown;
  try {
    parseAdvanced(spec, raw, NOW);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(AdvancedFilterError);
  expect((err as AdvancedFilterError).issues.map((i) => `${i.param}: ${i.message}`).join(' | ')).toMatch(pattern);
};

describe('query builder → OData', () => {
  it('compiles every operator with $odata quoting, ISO dates, validated GUIDs and mapped properties', () => {
    expect(compile(odata, one('department', 'eq', "O'Brien & Co"))).toBe("department eq 'O''Brien & Co'");
    expect(compile(odata, one('department', 'ne', 'Sales'))).toBe("department ne 'Sales'");
    expect(compile(odata, one('department', 'startsWith', 'Fin'))).toBe("startswith(department, 'Fin')");
    expect(compile(odata, one('department', 'contains', 'ops'))).toBe("contains(department, 'ops')");
    expect(compile(odata, one('department', 'in', ['IT', "R'D"]))).toBe("department in ('IT', 'R''D')");
    expect(compile(odata, one('department', 'isEmpty'))).toBe('department eq null');
    expect(compile(odata, one('created', 'ge', '2026-01-31'))).toBe('createdDateTime ge 2026-01-31T00:00:00.000Z');
    expect(compile(odata, one('created', 'le', '-30d'))).toBe('createdDateTime le 2026-09-15T12:00:00.000Z');
    expect(compile(odata, one('seats', 'gt', 10))).toBe('seats gt 10');
    expect(compile(odata, one('seats', 'in', [1, 2.5]))).toBe('seats in (1, 2.5)');
    expect(compile(odata, one('enabled', 'eq', false))).toBe('accountEnabled eq false');
    expect(compile(odata, one('owner', 'eq', 'ABCDEF01-2345-4678-89AB-CDEF01234567'))).toBe("owner eq 'abcdef01-2345-4678-89ab-cdef01234567'");
    expect(compile(odata, one('kind', 'in', ['Guest']))).toBe("kind in ('Guest')");
  });

  it('groups: all → and, any → or, always parenthesised so `… and ${ advanced }` keeps its meaning', () => {
    const f = { all: [{ field: 'enabled', op: 'eq', value: true }, { any: [{ field: 'department', op: 'eq', value: 'IT' }, { field: 'department', op: 'startsWith', value: 'Ops' }] }] };
    expect(compile(odata, f)).toBe("(accountEnabled eq true and (department eq 'IT' or startswith(department, 'Ops')))");
    expect(compile(odata, { any: [{ field: 'kind', op: 'eq', value: 'Guest' }, { field: 'enabled', op: 'eq', value: false }] })).toBe("(kind eq 'Guest' or accountEnabled eq false)");
    expect(compile(odata, { all: [] })).toBeUndefined();
    expect(compile(odata, undefined)).toBeUndefined();
    expect(compile(odata, '')).toBeUndefined();
  });

  it('injection attempts end up inside one quoted literal or are rejected', () => {
    for (const evil of ["') or true or ('", "x' or 1 eq 1 or department eq 'y", "Sales') or startswith(userPrincipalName, 'a"]) {
      expect(compile(odata, one('department', 'eq', evil))).toBe(`department eq ${odataString(evil)}`);
      // The compiled literal has balanced quotes: every quote inside the value is doubled.
      expect(compile(odata, one('department', 'eq', evil))!.slice('department eq '.length)).toMatch(/^'(?:[^']|'')*'$/);
    }
    rejects(odata, one('department', 'eq', 'a\u0000b'), /control characters/);
    rejects(odata, one('seats', 'gt', '10 or 1 eq 1'), /seats gt: expects a number/);
    rejects(odata, one('enabled', 'eq', 'true or true'), /expects true or false/);
    rejects(odata, one('owner', 'eq', "00000000-0000-4000-8000-000000000001' or 'a"), /expects a GUID/);
    rejects(odata, one('created', 'ge', '2026-01-01) or (true'), /expects an ISO date/);
    rejects(odata, one('kind', 'eq', 'Admin'), /expects one of Member, Guest/);
  });

  it('rejects unknown fields and operators, client-side property overrides, extra keys, deep nesting and too many conditions', () => {
    rejects(odata, one('userPrincipalName', 'eq', 'x'), /unknown field "userPrincipalName"/);
    rejects(odata, one('department', 'gt', 'x'), /department does not support "gt"/);
    rejects(odata, one('department', 'eq) or (true', 'x'), /does not support/);
    rejects(odata, { all: [{ field: 'department', op: 'eq', value: 'x', property: 'userPrincipalName' }] }, /not a valid filter/);
    rejects(odata, { all: [], raw: "1 eq 1" }, /not a valid filter/);
    rejects(odata, { all: [{ any: [{ all: [{ field: 'department', op: 'eq', value: 'x' }] }] }] }, /not a valid filter/);
    rejects(odata, { all: Array.from({ length: MAX_CONDITIONS + 1 }, () => ({ field: 'department', op: 'eq', value: 'x' })) }, /not a valid filter|at most 20/);
    rejects(odata, { all: [{ any: Array.from({ length: 11 }, () => ({ field: 'seats', op: 'eq', value: 1 })) }, { any: Array.from({ length: 10 }, () => ({ field: 'seats', op: 'eq', value: 1 })) }] }, /at most 20 conditions/);
    rejects(odata, one('department', 'in', []), /list of 1–50/);
    rejects(odata, one('department', 'in', Array.from({ length: 51 }, (_, i) => `d${i}`)), /not a valid filter/);
    rejects(odata, one('department', 'eq', ['a', 'b']), /single value/);
    rejects(odata, one('department', 'isEmpty', 'x'), /takes no value/);
    rejects(odata, "department eq 'x' or true", /must be the query builder filter/);
    rejects(odata, 'not base64!', /must be the query builder filter/);
  });

  it('accepts the filter as an object, JSON text or base64url JSON (the URL form)', () => {
    const f = one('department', 'eq', 'IT');
    const b64 = Buffer.from(JSON.stringify(f)).toString('base64url');
    expect(decodeAdvanced(b64)).toEqual(f);
    expect(compile(odata, b64)).toBe("department eq 'IT'");
    expect(compile(odata, JSON.stringify(f))).toBe("department eq 'IT'");
    expect(describeAdvanced(parseAdvanced(odata, { any: [{ field: 'department', op: 'isEmpty' }, { all: [{ field: 'seats', op: 'gt', value: 3 }] }] }, NOW)!)).toEqual({
      any: [{ field: 'department', op: 'isEmpty' }, { all: [{ field: 'seats', op: 'gt', value: 3 }] }],
    });
  });
});

describe('query builder → KQL', () => {
  it('compiles every operator with KQL quoting (case-insensitive string comparisons)', () => {
    expect(compile(kql, one('department', 'eq', 'IT'))).toBe("department =~ 'IT'");
    expect(compile(kql, one('department', 'ne', 'IT'))).toBe("department !~ 'IT'");
    expect(compile(kql, one('department', 'startsWith', 'rg-'))).toBe("department startswith 'rg-'");
    expect(compile(kql, one('department', 'contains', 'web'))).toBe("department contains 'web'");
    expect(compile(kql, one('department', 'in', ['a', 'b']))).toBe("department in~ ('a', 'b')");
    expect(compile(kql, one('department', 'isEmpty'))).toBe('isempty(department)');
    expect(compile(kql, one('seats', 'eq', 3))).toBe('seats == 3');
    expect(compile(kql, one('seats', 'le', 3))).toBe('seats <= 3');
    expect(compile(kql, one('seats', 'in', [1, 2]))).toBe('seats in (1, 2)');
    expect(compile(kql, one('created', 'ge', '2026-01-31'))).toBe('createdTime >= datetime(2026-01-31T00:00:00.000Z)');
    expect(compile(kql, one('enabled', 'eq', true))).toBe('accountEnabled == true');
    expect(compile(kql, one('owner', 'in', ['00000000-0000-4000-8000-000000000001']))).toBe("owner in~ ('00000000-0000-4000-8000-000000000001')");
    expect(compile(kql, one('state', 'eq', 'Succeeded'))).toBe("properties.provisioningState =~ 'Succeeded'");
    expect(compile(kql, { any: [one('seats', 'gt', 1).all[0], one('department', 'eq', 'x').all[0]] })).toBe("(seats > 1 or department =~ 'x')");
  });

  it('pipes, quotes, backslashes and comments in values stay inside the string literal', () => {
    for (const evil of ["x' | take 1 //", "a\\' | project secret", "x' or 1 == 1 or name == '", '") | union (Resources']) {
      const out = compile(kql, one('department', 'eq', evil))!;
      expect(out).toBe(`department =~ ${kqlString(evil)}`);
      // One literal: after the opening quote every quote is escaped until the closing one.
      expect(out.slice('department =~ '.length)).toMatch(/^'(?:[^'\\]|\\.)*'$/);
    }
    expect(kqlString("it's a\\b")).toBe("'it\\'s a\\\\b'");
  });
});

describe('schema rules for filters.advanced', () => {
  const page = (extra: string) => `kind: page
id: identity.example
version: 1.0.0
title: Example
owner: t
template: list-detail
${extra}layout:
  - { widget: kpi }
`;
  const errors = (text: string) => {
    const r = parseDefinition(text, 'x.page.yaml');
    return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
  };
  const ADV = `filters:
  advanced:
    dialect: odata
    fields:
      - { field: department, label: Department, type: string }
`;

  it('accepts structured fields and the compiled value in templates', () => {
    expect(errors(page(`${ADV}datasources:\n  users:\n    source: graph\n    request:\n      path: /users\n      query:\n        $filter: \${ advanced }\n`))).toEqual([]);
  });

  it('rejects declaring the builder param, reading it raw, bad operators, enums without values and wrong property syntax', () => {
    expect(errors(page(`params:\n  adv: { type: string, hidden: true }\n${ADV}`))).toEqual([expect.stringMatching(/^params\.adv: "adv" carries the query builder's filter/)]);
    for (const read of ['${ params.adv }', '${ params["adv"] }', "${ $lookup(params, 'adv') }"])
      expect(errors(page(`${ADV}datasources:\n  users:\n    source: graph\n    request:\n      path: /users\n      query:\n        $filter: "${read.replace(/"/g, '\\"')}"\n`))).toEqual([
        expect.stringMatching(/^filters\.advanced\.param: Expressions must not read params\.adv/),
      ]);
    expect(errors(page(`filters:\n  advanced:\n    dialect: odata\n    param: where\n    fields:\n      - { field: n, label: N, type: number, operators: [startsWith] }\n      - { field: e, label: E, type: enum }\n      - { field: p, label: P, type: string, property: a.b }\ndatasources:\n  x: { source: static, data: "\${ params.where }" }\n`))).toEqual([
      expect.stringMatching(/^filters\.advanced\.param: Expressions must not read params\.where/),
      'filters.advanced.fields[0].operators[0]: startsWith does not apply to number fields (use eq, ne, gt, ge, lt, le, in, isEmpty).',
      'filters.advanced.fields[1].values: enum fields need values.',
      'filters.advanced.fields[2].property: OData property paths use / (e.g. signInActivity/lastSignInDateTime).',
    ]);
    expect(errors(page(`filters:\n  advanced:\n    dialect: odata\n    fields:\n      - { field: "a eq 1 or b", label: X, type: string }\n`))).toEqual([expect.stringMatching(/^filters\.advanced\.fields\[0\]\.field: Use letters, digits and _ only/)]);
  });
});
