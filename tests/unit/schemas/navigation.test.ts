import { type Navigation } from '@adminforge/schemas';
import { brief, ENVELOPE, errors, ok } from './helpers';

const nav = (sections: string) => `${ENVELOPE('navigation', 'portal.navigation')}sections:\n${sections}`;

describe('navigation', () => {
  it('accepts sections with icons, roles and coded items', () => {
    const def = ok<Navigation>(nav('  - { key: identity, label: Identity, icon: identification-card, order: 20 }\n  - key: admin\n    label: Admin\n    icon: gear-six\n    roles: [Portal.Admin]\n    items: [{ key: audit, label: Audit, href: /admin/audit }]\n'));
    expect(def.sections.map((s) => s.key)).toEqual(['identity', 'admin']);
  });
  it.each([
    ['duplicate section keys', '  - { key: a, label: A, icon: house }\n  - { key: a, label: B, icon: house }\n', 'sections[1].key@8'],
    ['a missing icon', '  - { key: a, label: A }\n', 'sections[0].icon@7'],
    ['a PascalCase icon', '  - { key: a, label: A, icon: ShieldCheck }\n', 'sections[0].icon@7'],
    ['an external item href', '  - { key: a, label: A, icon: house, items: [{ key: x, label: X, href: "https://example.com" }] }\n', 'sections[0].items[0].href@7'],
    ['duplicate item keys', '  - { key: a, label: A, icon: house, items: [{ key: x, label: X, href: /x }, { key: x, label: Y, href: /y }] }\n', 'sections[0].items[1].key@7'],
  ])('rejects %s', (_label, sections, at) => expect(brief(errors(nav(sections)))).toEqual([at]));
});
