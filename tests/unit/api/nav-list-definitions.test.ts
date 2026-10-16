import { composeNav } from '@adminforge/api/src/routes/nav';
import type { DefinitionRecord } from '@adminforge/api/src/definitions/types';
import type { Navigation } from '@adminforge/schemas';

// navigation.yaml `listDefinitions: false`: the section shows only its coded items (Reports → "All reports"); the
// definitions that name it in `nav.section` are left out of the rail (they stay reachable by URL, search and catalogue).

const def = (kind: 'page' | 'report', id: string, section: string, extra: Record<string, unknown> = {}) =>
  ({
    kind,
    key: id,
    version: '1.0.0',
    sha256: 'x',
    status: 'published',
    source: 'fs',
    def: { kind, id, version: '1.0.0', title: id, owner: 't', nav: { section }, layout: [], ...extra },
  }) as unknown as DefinitionRecord;

const definitions = [
  def('report', 'identity.inactive-users', 'reports', { requires: { licences: ['AAD_PREMIUM'] } }),
  def('report', 'azure.monthly-cost', 'reports'),
  def('page', 'identity.users', 'identity'),
];

const navigation = (listDefinitions?: boolean) =>
  ({
    sections: [
      { key: 'identity', label: 'Identity', icon: 'identification-card', order: 20 },
      {
        key: 'reports',
        label: 'Reports',
        icon: 'chart-bar',
        order: 80,
        ...(listDefinitions === undefined ? {} : { listDefinitions }),
        items: [
          { key: 'reports-catalog', label: 'All reports', href: '/reports', icon: 'chart-bar', order: 10 },
        ],
      },
    ],
  }) as unknown as Navigation;

describe('composeNav with listDefinitions', () => {
  it('false: the section lists only its items', () => {
    const nav = composeNav({ navigation: navigation(false), definitions, roles: [], licences: null });
    expect(nav.sections.map((s) => [s.key, s.items.map((i) => i.key)])).toEqual([
      ['identity', ['identity.users']],
      ['reports', ['reports-catalog']],
    ]);
    expect(nav.sections[1]!.items[0]).toEqual({
      key: 'reports-catalog',
      label: 'All reports',
      href: '/reports',
      icon: 'chart-bar',
    });
  });

  it('default (true): definitions join the section as before', () => {
    for (const listDefinitions of [undefined, true]) {
      const nav = composeNav({
        navigation: navigation(listDefinitions),
        definitions,
        roles: [],
        licences: null,
      });
      expect(nav.sections[1]!.items.map((i) => i.key)).toEqual([
        'reports-catalog',
        'azure.monthly-cost',
        'identity.inactive-users',
      ]);
    }
  });
});
