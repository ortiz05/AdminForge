import { parseDefinition } from '@adminforge/schemas';

const page = (dialect: string, transform: string | null, property = 'owner.displayName') => `kind: page
id: m365.rows-test
version: 1.0.0
title: Rows
owner: t
template: list-detail
filters:
  advanced:
    dialect: ${dialect}
    fields:
      - { field: type, label: Type, type: enum, values: [UserMailbox, SharedMailbox] }
      - { field: owner, label: Owner, type: string, property: ${property} }
datasources:
  rows:
    source: static
    data: []
${transform === null ? '' : `    transform: "${transform}"\n`}layout:
  - widget: table
    data: rows
    columns: [{ field: type, label: Type }]
`;

const issues = (text: string) => {
  const r = parseDefinition(text, 'test.yaml');
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

describe('filters.advanced.dialect: rows', () => {
  it('accepts a page whose transform applies the filter with $applyAdvanced(rows, advanced)', () => {
    expect(issues(page('rows', '${ $applyAdvanced(value, advanced) }'))).toEqual([]);
    expect(issues(page('rows', '${ { \\"rows\\": $applyAdvanced(value.items, advanced) } }'))).toEqual([]);
  });

  it('refuses a rows page that never applies the filter (the builder would do nothing)', () => {
    expect(issues(page('rows', null))).toEqual([
      'filters.advanced.dialect: dialect: rows needs a datasource transform that keeps the matching rows with $applyAdvanced(<rows>, advanced).',
    ]);
    expect(issues(page('rows', '${ value }'))).toHaveLength(1);
  });

  it('uses dot paths for row fields', () => {
    expect(issues(page('rows', '${ $applyAdvanced(value, advanced) }', 'owner/displayName'))).toEqual([
      'filters.advanced.fields[1].property: Row fields use . (e.g. owner.displayName).',
    ]);
  });

  it('leaves the other dialects as they were', () => {
    expect(issues(page('kql', null, 'properties.state'))).toEqual([]);
    expect(issues(page('client', null, 'owner.displayName'))).toEqual([]);
  });
});
