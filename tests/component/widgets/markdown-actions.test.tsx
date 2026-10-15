import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  WIDGETS,
  actionBarFixtures,
  markdownFixtures,
  parseBlocks,
  safeHref,
  type ActionBarConfig,
  type MarkdownConfig,
} from '@adminforge/widgets';
import { axeViolations } from '../axe';
import { ready, renderWidget, spyRuntime } from './helpers';

const Markdown = WIDGETS.markdown!.component;
const ActionBar = WIDGETS.actionBar!.component;
const md = (c: unknown) => WIDGETS.markdown!.schema.parse(c) as MarkdownConfig;

describe('markdown widget', () => {
  // The shallowest heading becomes h3 (the page owns h1, panels own h2), so `##` here is h3 and levels never skip.
  it('renders the safe subset: headings, emphasis, code, lists, in-app and external links', async () => {
    const { container } = renderWidget(Markdown, md(markdownFixtures.guidance.config), ready(undefined));
    const panel = screen.getByRole('region', { name: 'About this page' });
    expect(within(panel).getByRole('heading', { level: 3, name: 'What you see' })).toBeInTheDocument();
    expect(within(panel).getByText('member', { selector: 'strong' })).toBeInTheDocument();
    expect(within(panel).getByText('guest', { selector: 'em' })).toBeInTheDocument();
    expect(within(panel).getByText('Disable sign-in', { selector: 'code' })).toBeInTheDocument();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(2);
    expect(within(panel).getByRole('link', { name: 'offboarding runbook' })).toHaveAttribute(
      'href',
      '/runbooks/identity.offboarding',
    );
    const external = within(panel).getByRole('link', { name: /Entra docs/ });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noreferrer');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('never renders raw HTML; javascript: links stay text', () => {
    const { container } = renderWidget(Markdown, md(markdownFixtures.hostile.config), ready(undefined));
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(container).toHaveTextContent('click');
  });

  it('templated text: values from data are inserted as plain text with HTML stripped', async () => {
    const { runtime } = spyRuntime({
      data: {
        post: {
          title: 'Plan for change',
          body: '<p>Retire <b>legacy</b> connectors &amp; bots.</p><script>alert(1)</script>',
        },
      },
    });
    const { container } = renderWidget(
      Markdown,
      md({ widget: 'markdown', title: 'Message', text: '## ${ post.title }\n\n${ post.body }' }),
      ready(undefined),
      runtime,
    );
    expect(await screen.findByRole('heading', { level: 3, name: 'Plan for change' })).toBeInTheDocument();
    expect(screen.getByText('Retire legacy connectors & bots.')).toBeInTheDocument();
    expect(container.querySelector('script, b')).toBeNull();
  });

  it('keeps relative heading depth without skipping levels', () => {
    renderWidget(
      Markdown,
      md({ widget: 'markdown', title: 'Guide', text: '## Steps\n\n### First\n\ntext' }),
      ready(undefined),
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Steps' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: 'First' })).toBeInTheDocument();
  });

  it('parseBlocks and safeHref', () => {
    expect(parseBlocks('# T\n\npara one\nstill one\n\n1. a\n2. b\n\n```\ncode\n```\n---')).toEqual([
      { type: 'heading', level: 1, text: 'T' },
      { type: 'paragraph', text: 'para one still one' },
      { type: 'list', ordered: true, items: ['a', 'b'] },
      { type: 'code', text: 'code' },
      { type: 'rule' },
    ]);
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('//evil.example.com')).toBeNull();
    expect(safeHref('/p/identity.users')).toEqual({ href: '/p/identity.users', external: false });
    expect(safeHref('https://learn.microsoft.com/')).toEqual({
      href: 'https://learn.microsoft.com/',
      external: true,
    });
  });
});

describe('actionBar widget', () => {
  const config = WIDGETS.actionBar!.schema.parse(actionBarFixtures.user.config) as ActionBarConfig;

  it('playbook buttons render inputs from the page scope; `when` hides actions; links open in a new tab', async () => {
    const user = userEvent.setup();
    const { runtime, openPlaybook } = spyRuntime({
      scope: { params: { id: '0a1b2c3d-0000-4000-8000-000000000001' }, user: { accountEnabled: false } },
    });
    const { container } = renderWidget(ActionBar, config, ready(undefined), runtime);
    const group = screen.getByRole('group', { name: 'Actions' });
    await user.click(within(group).getByRole('button', { name: 'Disable sign-in' }));
    await waitFor(() =>
      expect(openPlaybook).toHaveBeenCalledWith({
        playbook: 'identity.disable-user',
        inputs: { userId: '0a1b2c3d-0000-4000-8000-000000000001' },
      }),
    );
    // `when: user.accountEnabled = true` is false here.
    await new Promise((r) => setTimeout(r, 30));
    expect(within(group).queryByRole('button', { name: 'Reset MFA' })).toBeNull();
    const link = within(group).getByRole('link', { name: /Open in Entra admin center/ });
    expect(link).toHaveAttribute('href', 'https://entra.microsoft.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('shows conditional actions once their `when` holds', async () => {
    const { runtime } = spyRuntime({ scope: { params: { id: 'x' }, user: { accountEnabled: true } } });
    renderWidget(ActionBar, config, ready(undefined), runtime);
    expect(await screen.findByRole('button', { name: 'Reset MFA' })).toBeInTheDocument();
  });
});
