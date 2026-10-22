import { exportTable } from '@adminforge/schemas';
import type { Block } from '@adminforge/web/src/renderer/blocks';
import { exportTableId } from '@adminforge/web/src/renderer/page-model';

// The browser sends the visible columns of the table an export reads, and the server takes its columns from the same
// table (`exportTable`, schemas): with `export.data` a template over params, the table the rendered path names; a
// capped table exports every row through the uncapped list it is a static view of.
const blocks = [
  { id: 'kpi', widget: 'kpi', data: 'counts.total' },
  { id: 'groups', widget: 'table', data: 'groups.value' },
  { id: 'groupList', widget: 'table', data: 'groupList.rows' },
] as unknown as Block[];
const datasources = {
  groups: { source: 'graph' },
  memberMatches: { source: 'static', data: '${ ds.everyGroup }' },
  groupList: { source: 'static', data: '${ ds.memberMatches }' },
} as never;

describe('the table an export reads', () => {
  it('is the first table without export.data', () => {
    expect(exportTableId(blocks, datasources, undefined, undefined)).toBe('groups');
  });

  it('is the table bound to the path export.data names, as rendered for the params', () => {
    expect(exportTableId(blocks, datasources, 'groups.value', 'groups.value')).toBe('groups');
    expect(
      exportTableId(
        blocks,
        datasources,
        "${ params.v = 'x' ? 'groupList.rows' : 'groups.value' }",
        'groupList.rows',
      ),
    ).toBe('groupList');
  });

  it('is the table bound to a static view of the exported list (a capped table that exports every row)', () => {
    expect(exportTableId(blocks, datasources, '${ x }', 'memberMatches.rows')).toBe('groupList');
  });

  it('is none while the template renders, or when it names no table', () => {
    expect(exportTableId(blocks, datasources, '${ x }', undefined)).toBeUndefined();
    expect(exportTableId(blocks, datasources, '${ x }', 42)).toBeUndefined();
    expect(exportTableId(blocks, datasources, '${ x }', 'nothing.here')).toBeUndefined();
    expect(exportTable(blocks, datasources, '${ x }', 'a(b.c')).toBeUndefined();
  });
});
