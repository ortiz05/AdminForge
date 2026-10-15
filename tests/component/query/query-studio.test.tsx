import '../web/ensure-route-tree';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, createAppRouter, createQueryClient } from '@adminforge/web/src/app/router';
import { __resetPrefsForTests } from '@adminforge/web/src/lib/prefs';
import { __resetHistoryForTests, HISTORY_KEY } from '@adminforge/web/src/query/history';
import { GALLERY } from '@adminforge/web/src/query/gallery';
import { CAPABILITIES_NO_DEFENDER, answerQuery, QIDS } from '../../e2e/fixtures/query';
import { me, NAV } from '../../e2e/fixtures/session';
import { axeViolations } from '../axe';

/**
 * Monaco needs real layout and workers, so component tests swap the lazy editor for a textarea with the same
 * contract (value, onChange, Ctrl/⌘+Enter → onRun). Playwright covers the real editor.
 */
vi.mock('@adminforge/web/src/query/KqlEditor', async () => {
  const { createElement, useEffect } = await import('react');
  function MockKqlEditor(props: {
    value: string;
    onChange: (v: string) => void;
    onRun: () => void;
    ariaLabel: string;
    tables: readonly string[];
    onReady?: (api: { focus: () => void }) => void;
  }) {
    const { onReady } = props;
    useEffect(() => onReady?.({ focus: () => document.getElementById('mock-kql')?.focus() }), [onReady]);
    return createElement('textarea', {
      id: 'mock-kql',
      'aria-label': props.ariaLabel,
      'data-tables': props.tables.join(','),
      value: props.value,
      onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
      onKeyDown: (e: KeyboardEvent & { stopPropagation(): void }) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          e.stopPropagation();
          props.onRun();
        }
      },
    });
  }
  return { default: MockKqlEditor };
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

function renderStudio({
  path = '/query',
  capabilities = CAPABILITIES_NO_DEFENDER as unknown,
}: { path?: string; capabilities?: unknown } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ method, url, body });
      if (url === '/api/me') return json(me());
      if (url === '/api/nav') return json(NAV);
      if (url === '/api/me/capabilities') return json(capabilities);
      if (method === 'POST' && url.startsWith('/api/query')) {
        const reply = answerQuery(url, body ?? {});
        if (reply) return json(reply.body, reply.status);
      }
      if (url === '/api/runs') return json({ items: [] });
      return json({ ok: true });
    }),
  );
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createAppRouter(queryClient, { initialPath: path });
  render(<App router={router} queryClient={queryClient} />);
  const runs = () =>
    calls.filter(
      (c) =>
        c.method === 'POST' &&
        c.url === '/api/query' &&
        !/resourcecontainers|operationalinsights\/workspaces/.test(String(c.body?.query)),
    );
  return { calls, runs, router };
}

const editor = (name = /Azure Resource Graph query/) => screen.findByRole('textbox', { name });

async function typeQuery(user: ReturnType<typeof userEvent.setup>, text: string, name?: RegExp) {
  const box = await editor(name);
  await user.clear(box);
  // userEvent treats { and [ as key descriptors; KQL here avoids them.
  await user.type(box, text);
  return box;
}

describe('Query Studio (/query)', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPrefsForTests({});
    __resetHistoryForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('loads with Resource Graph, offers its starter queries, and runs one into a typed results table', async () => {
    const user = userEvent.setup();
    const { runs } = renderStudio();
    expect(await screen.findByRole('heading', { level: 1, name: 'Query Studio' })).toBeInTheDocument();
    const box = await editor();
    expect(box).toHaveAttribute('data-tables', expect.stringContaining('resourcecontainers'));

    const starters = screen.getByRole('list', { name: 'Starter queries for Azure Resource Graph' });
    const titles = within(starters)
      .getAllByRole('button')
      .map((b) => b.querySelector('span span')?.textContent);
    expect(titles).toEqual(GALLERY.filter((q) => q.source === 'resourceGraph').map((q) => q.title));
    await user.click(within(starters).getByRole('button', { name: /Inventory by type and region/ }));
    expect(box).toHaveValue(GALLERY.find((q) => q.id === 'arg.inventory')!.query);
    expect(within(starters).getByRole('button', { name: /Inventory by type and region/ })).toHaveAttribute(
      'aria-current',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Run' }));
    const grid = await screen.findByRole('grid', { name: 'Query results' });
    expect(runs()).toHaveLength(1);
    expect(runs()[0]!.body).toEqual({
      source: 'resourceGraph',
      query: GALLERY.find((q) => q.id === 'arg.inventory')!.query,
    });

    const results = screen.getByRole('region', { name: 'Results' });
    // Header line: rows · duration · source (the table toolbar repeats the row count).
    expect(within(results).getAllByText('12 rows').length).toBeGreaterThan(0);
    expect(within(results).getAllByText('1.2 s').length).toBeGreaterThan(0);
    expect(within(results).getByText('/providers/Microsoft.ResourceGraph/resources')).toBeInTheDocument();
    expect(within(grid).getByRole('columnheader', { name: /resources/ })).toBeInTheDocument();
    expect(within(grid).getAllByText('microsoft.compute/virtualmachines').length).toBeGreaterThan(0);
    // Column types are listed in the schema disclosure.
    expect(within(results).getByRole('list', { name: 'Result columns and types' })).toHaveTextContent(
      'resourceslong',
    );
    expect(await axeViolations()).toEqual([]);
  });

  it('runs with Ctrl+Enter from the editor, keeps history in localStorage, and reloads a query from history', async () => {
    const user = userEvent.setup();
    const { runs } = renderStudio();
    await typeQuery(user, "resources | where type =~ 'microsoft.web/sites'");
    await user.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByRole('grid', { name: 'Query results' });
    expect(runs()).toHaveLength(1);
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as Array<{
      query: string;
      rowCount: number;
      source: string;
    }>;
    expect(stored[0]).toMatchObject({
      source: 'resourceGraph',
      query: "resources | where type =~ 'microsoft.web/sites'",
      rowCount: 12,
    });

    await typeQuery(user, 'resources | take 5');
    await user.click(screen.getByRole('tab', { name: 'History' }));
    const history = screen.getByRole('list', { name: 'Query history' });
    await user.click(within(history).getByRole('button', { name: /microsoft\.web\/sites/ }));
    expect(await editor()).toHaveValue("resources | where type =~ 'microsoft.web/sites'");
    expect(await axeViolations()).toEqual([]);
  });

  it('scopes Resource Graph to chosen subscriptions', async () => {
    const user = userEvent.setup();
    const { runs } = renderStudio();
    await editor();
    await user.click(screen.getByRole('button', { name: /Scope/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Example Production/ }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /Scope/ })).toHaveTextContent('Example Production');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('grid', { name: 'Query results' });
    expect(runs()[0]!.body).toMatchObject({ source: 'resourceGraph', subscriptions: [QIDS.subProd] });
  });

  it('Log Analytics: the default workspace is left to the server, the time range is sent, a custom workspace id is validated', async () => {
    const user = userEvent.setup();
    const { runs } = renderStudio({ path: '/query?source=logAnalytics' });
    const box = await editor(/Log Analytics query/);
    expect(box).toHaveAttribute('data-tables', expect.stringContaining('AzureActivity'));
    expect(screen.getByRole('radio', { name: 'Log Analytics' })).toHaveAttribute('aria-checked', 'true');

    await user.click(
      within(screen.getByRole('list', { name: /Starter queries for Log Analytics/ })).getByRole('button', {
        name: /Failed Azure writes/,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const grid = await screen.findByRole('grid', { name: 'Query results' });
    expect(runs()[0]!.body).toEqual({
      source: 'logAnalytics',
      query: expect.stringContaining('AzureActivity'),
      timespan: 'P1D',
    });
    expect(within(grid).getByText('2026-10-15 13:41:07 UTC')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Workspace' }));
    await user.click(await screen.findByRole('option', { name: /Another workspace/ }));
    await user.type(screen.getByRole('textbox', { name: 'Workspace id' }), 'not-a-guid');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the workspace id');
    expect(runs()).toHaveLength(1);

    await user.clear(screen.getByRole('textbox', { name: 'Workspace id' }));
    await user.type(screen.getByRole('textbox', { name: 'Workspace id' }), QIDS.workspace.toUpperCase());
    await user.click(screen.getByRole('combobox', { name: 'Time range' }));
    await user.click(await screen.findByRole('option', { name: 'Set in query' }));
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runs()).toHaveLength(2));
    expect(runs()[1]!.body).toEqual({
      source: 'logAnalytics',
      query: expect.any(String),
      workspace: QIDS.workspace,
    });
  });

  it('Defender advanced hunting shows the licence note from /api/me/capabilities', async () => {
    renderStudio({ path: '/query?source=advancedHunting' });
    await editor(/Defender advanced hunting query/);
    const note = await screen.findByText('Advanced hunting needs Microsoft Defender XDR');
    const callout = note.closest('div')!.parentElement!;
    expect(callout).toHaveTextContent(
      'Requires Microsoft Defender XDR / Defender for Endpoint (MTP or WINDEFATP). Queries return an error until the tenant has it',
    );
    // The SKU is already named in the reason, so it is not repeated.
    expect(callout).not.toHaveTextContent('Look for MTP');
    expect(await axeViolations()).toEqual([]);
  });

  it('says nothing about licences when Defender is licensed', async () => {
    renderStudio({
      path: '/query?source=advancedHunting',
      capabilities: {
        roles: { active: [], eligible: [] },
        features: { defender: { available: true, sku: 'SPE_E5' } },
      },
    });
    await editor(/Defender advanced hunting query/);
    await waitFor(() => expect(screen.queryByText(/needs Microsoft Defender XDR/)).not.toBeInTheDocument());
  });

  it('shows the service error with its hint, code and correlation id; empty and truncated results explain themselves', async () => {
    const user = userEvent.setup();
    renderStudio();
    await typeQuery(user, 'resources\n| summarise count() by type');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The query didn’t run');
    expect(alert).toHaveTextContent("'summarise' is not a recognised operator");
    expect(alert).toHaveTextContent('KQL uses summarize');
    expect(alert).toHaveTextContent('invalid_query');
    expect(await axeViolations()).toEqual([]);

    await typeQuery(user, "resources | where name == 'nothing'");
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('No rows')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Untagged resources/ }));
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const results = screen.getByRole('region', { name: 'Results' });
    expect(await within(results).findByText('40 of 1,312 rows')).toBeInTheDocument();
    expect(within(results).getByText('Truncated')).toBeInTheDocument();
    expect(within(results).getByText(/Only the first 40 of 1,312 rows came back/)).toBeInTheDocument();
  });

  it('charts a result: suggested axes from the starter, and an explanation when nothing is numeric', async () => {
    const user = userEvent.setup();
    renderStudio({ path: '/query?source=logAnalytics' });
    await editor(/Log Analytics query/);
    await user.click(screen.getByRole('button', { name: /Azure changes by caller/ }));
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('grid', { name: 'Query results' });
    await user.click(screen.getByRole('radio', { name: 'Chart' }));
    expect(screen.getByRole('combobox', { name: 'X axis' })).toHaveTextContent('TimeGenerated');
    expect(screen.getByRole('combobox', { name: 'Y axis' })).toHaveTextContent('changes');
    expect(screen.getByRole('combobox', { name: 'Split by' })).toHaveTextContent('Caller');
    expect(screen.getByRole('radio', { name: 'Area' })).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByRole('figure', { name: 'changes by TimeGenerated, split by Caller' }),
    ).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);

    // The chart view stays selected for the next run; a result without numbers says how to get some.
    await user.click(screen.getByRole('button', { name: /Failed Azure writes/ }));
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Nothing to chart')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Table' }));
    expect(await screen.findByRole('grid', { name: 'Query results' })).toBeInTheDocument();
  });

  it('saves a query as a report: scaffold request, YAML with its path, and the steps to commit it', async () => {
    const user = userEvent.setup();
    const { calls } = renderStudio();
    await editor();
    await user.click(screen.getByRole('button', { name: /Inventory by type and region/ }));
    await user.click(screen.getByRole('button', { name: /Save as/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Report' }));

    const dialog = await screen.findByRole('dialog', { name: 'Save as report' });
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Inventory by type and region',
    );
    expect(await axeViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Create report YAML' }));

    const ready = await screen.findByRole('dialog', { name: 'Your report file is ready' });
    const scaffold = calls.find((c) => c.url === '/api/query/scaffold')!;
    expect(scaffold.body).toEqual({
      as: 'report',
      source: 'resourceGraph',
      query: GALLERY.find((q) => q.id === 'arg.inventory')!.query,
      title: 'Inventory by type and region',
    });
    const path = 'portal/content/reports/azure/inventory-by-type-and-region.report.yaml';
    expect(within(ready).getAllByText(path).length).toBeGreaterThan(0);
    expect(within(ready).getByRole('region', { name: path })).toHaveTextContent('kind: report');
    const commands = within(ready).getByRole('region', { name: 'Validate and commit' });
    expect(commands).toHaveTextContent('pnpm adminforge validate --scopes');
    expect(commands).toHaveTextContent(`git add ${path}`);
    expect(commands).toHaveTextContent('git switch -c content/azure.inventory-by-type-and-region');
    expect(within(ready).getByText('adding-a-page-or-report')).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it('saving after a run passes the result columns but never the subscription scope (tenant data stays out of content)', async () => {
    const user = userEvent.setup();
    const { calls } = renderStudio();
    await editor();
    await user.click(screen.getByRole('button', { name: /Scope/ }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Example Production/ }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /Inventory by type and region/ }));
    await user.click(screen.getByRole('button', { name: 'Run' }));
    await screen.findByRole('grid', { name: 'Query results' });
    await user.click(screen.getByRole('button', { name: /Save as/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Schedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as schedule' });
    expect(
      within(dialog).getByText(/subscription ids are configuration, so they are not saved in content/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Create schedule YAML' }));
    const ready = await screen.findByRole('dialog', { name: 'Your schedule file is ready' });
    const body = calls.find((c) => c.url === '/api/query/scaffold')!.body!;
    expect(body).toEqual({
      as: 'schedule',
      source: 'resourceGraph',
      query: GALLERY.find((q) => q.id === 'arg.inventory')!.query,
      title: 'Inventory by type and region',
      columns: [
        { name: 'type', type: 'string' },
        { name: 'location', type: 'string' },
        { name: 'resources', type: 'long' },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(QIDS.subProd);
    // The branch is named after the definition id the server chose.
    expect(within(ready).getByRole('region', { name: 'Validate and commit' })).toHaveTextContent(
      'git switch -c content/azure.inventory-by-type-and-region',
    );
  });

  it('requires a title before saving and never sends an empty query', async () => {
    const user = userEvent.setup();
    const { calls } = renderStudio();
    await typeQuery(user, 'resources | take 1');
    await user.click(screen.getByRole('button', { name: /Save as/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Probe/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as probe' });
    await user.click(within(dialog).getByRole('button', { name: 'Create probe YAML' }));
    expect(within(dialog).getByText('Give it a title.')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/query/scaffold')).toBe(false);
    await user.keyboard('{Escape}');

    await user.clear(await editor());
    expect(screen.getByRole('button', { name: /Save as/ })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Write a query first');
  });

  it('still runs when browser storage is blocked', async () => {
    const user = userEvent.setup();
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      __resetHistoryForTests();
      renderStudio();
      await editor();
      await user.click(screen.getByRole('button', { name: 'Run' }));
      expect(await screen.findByRole('grid', { name: 'Query results' })).toBeInTheDocument();
      await user.click(screen.getByRole('tab', { name: 'History' }));
      // Kept in memory for this session even though it could not be stored.
      expect(
        within(screen.getByRole('list', { name: 'Query history' })).getAllByRole('button', {
          name: /resources/,
        }).length,
      ).toBeGreaterThan(0);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
