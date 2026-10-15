import { screen, within } from '@testing-library/react';
import { escapeMarkdown, escapeMarkdownInline, safeUrl } from '@adminforge/ui';
import { WIDGETS, type ActionBarConfig, type KeyValueConfig, type MarkdownConfig } from '@adminforge/widgets';
import { ready, renderWidget, spyRuntime } from './helpers';

// Links built from content templates and tenant data follow one rule (safeUrl), and data placed into Markdown can't
// become a link (L1).
const ActionBar = WIDGETS.actionBar!.component;
const KeyValue = WIDGETS.keyValue!.component;
const Markdown = WIDGETS.markdown!.component;

const UNSAFE = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,x',
  '//evil.example.com',
  '/\\evil.example.com',
  '/\t/evil.example.com',
  '\n/evil',
  'https:///evil.example.com',
  'relative/path',
  '',
];

describe('safeUrl', () => {
  it('allows http(s), mailto, in-app paths and anchors; refuses everything that can leave the portal unexpectedly', () => {
    expect(safeUrl('https://learn.microsoft.com/')).toEqual({
      href: 'https://learn.microsoft.com/',
      external: true,
    });
    expect(safeUrl('mailto:ops@example.com')).toEqual({ href: 'mailto:ops@example.com', external: true });
    expect(safeUrl('/p/identity.users?q=a b')).toEqual({ href: '/p/identity.users?q=a b', external: false });
    expect(safeUrl('#section')).toEqual({ href: '#section', external: false });
    for (const href of UNSAFE) expect(safeUrl(href)).toBeNull();
  });

  it('escapeMarkdown / escapeMarkdownInline', () => {
    expect(escapeMarkdownInline('[x](/admin) *b* `c` _d_')).toBe(
      '\\[x\\]\\(/admin\\) \\*b\\* \\`c\\` \\_d\\_',
    );
    expect(escapeMarkdownInline('- keeps lists')).toBe('- keeps lists');
    expect(escapeMarkdown('- item\n# head')).toBe('\\- item\n\\# head');
  });
});

describe('action links (ActionButton)', () => {
  const config = WIDGETS.actionBar!.schema.parse({
    widget: 'actionBar',
    actions: [{ label: 'Open', href: '${ params.url }' }],
  }) as ActionBarConfig;

  it.each(UNSAFE.filter(Boolean))('a templated target %j is not rendered', async (url) => {
    const { runtime } = spyRuntime({ scope: { params: { url } } });
    renderWidget(ActionBar, config, ready(undefined), runtime);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('link', { name: /Open/ })).toBeNull();
  });

  it('safe targets render: external in a new tab, in-app through the router link', async () => {
    const ext = spyRuntime({ scope: { params: { url: 'https://entra.microsoft.com/' } } });
    const { unmount } = renderWidget(ActionBar, config, ready(undefined), ext.runtime);
    const link = await screen.findByRole('link', { name: /Open/ });
    expect(link).toHaveAttribute('href', 'https://entra.microsoft.com/');
    expect(link).toHaveAttribute('target', '_blank');
    unmount();
    const app = spyRuntime({ scope: { params: { url: '/p/identity.users' } } });
    renderWidget(ActionBar, config, ready(undefined), app.runtime);
    const inApp = await screen.findByRole('link', { name: /Open/ });
    expect(inApp).toHaveAttribute('href', '/p/identity.users');
    expect(inApp).not.toHaveAttribute('target');
  });
});

describe('keyValue link fields', () => {
  const config = WIDGETS.keyValue!.schema.parse({
    widget: 'keyValue',
    title: 'Profile',
    data: 'user',
    fields: [{ field: 'site', label: 'Site', kind: 'link' }],
  }) as KeyValueConfig;

  it('a value that is not a safe URL shows as text', async () => {
    const { container } = renderWidget(KeyValue, config, ready({ site: 'javascript:alert(1)' }));
    expect(await screen.findByText('javascript:alert(1)')).toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
  });

  it('a safe URL value is a link', async () => {
    renderWidget(KeyValue, config, ready({ site: 'https://contoso.sharepoint.com/sites/x' }));
    expect(await screen.findByRole('link', { name: /contoso/ })).toHaveAttribute('target', '_blank');
  });
});

describe('markdown widget with data', () => {
  it('a value that looks like Markdown stays text: no link, no emphasis', async () => {
    const { runtime } = spyRuntime({ data: { user: { name: '[Click here](/admin) **now**' } } });
    const config = WIDGETS.markdown!.schema.parse({
      widget: 'markdown',
      title: 'Note',
      text: 'Hello ${ user.name } — [docs](https://learn.microsoft.com/)',
    }) as MarkdownConfig;
    const { container } = renderWidget(Markdown, config, ready(undefined), runtime);
    expect(await screen.findByText(/Click here/)).toBeInTheDocument();
    expect(container).toHaveTextContent('Hello [Click here](/admin) **now** — docs');
    const links = within(container).getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['https://learn.microsoft.com/']);
    expect(container.querySelector('strong')).toBeNull();
  });
});
