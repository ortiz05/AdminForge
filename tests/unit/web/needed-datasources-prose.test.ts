import { neededDatasources, templateExpressions } from '@adminforge/web/src/renderer/page-model';
import type { PageDefinition } from '@adminforge/web/src/renderer/api';

// The browser fetches the datasources its blocks refer to: `data` references and names inside `${ … }`. Prose around
// an expression doesn't count — a note saying "10,000 sites are listed" on a page with a datasource called `sites`
// once made every browser download the whole site list.
const page = (layout: unknown[]) =>
  ({ datasources: { sites: {}, sharing: {}, admin: {} }, layout }) as unknown as PageDefinition;

describe('neededDatasources', () => {
  it('reads names in expressions and data references, not in the prose around them', () => {
    const def = page([
      { widget: 'markdown', text: '**The first 10,000 of ${ sharing.matched } sites are listed.**' },
      { widget: 'table', data: 'sharing.rows', rowActions: [{ href: '${ admin.url }' }] },
    ]);
    expect(neededDatasources(def, [def.layout])).toEqual(['sharing', 'admin']);
  });

  it('still finds a name used inside an expression', () => {
    const def = page([{ widget: 'markdown', text: 'Total: ${ $count(sites.all) } sites' }]);
    expect(neededDatasources(def, [def.layout])).toEqual(['sites']);
  });
});

describe('templateExpressions', () => {
  it('returns the expressions only, nested braces and braces in strings included', () => {
    expect(templateExpressions('a ${ x.y } b ${ { "k": "}" }.k } c')).toBe(' x.y   { "k": "}" }.k ');
    expect(templateExpressions('no expression')).toBe('');
    expect(templateExpressions("${ 'it\\'s' & sites }")).toContain('sites');
  });
});
