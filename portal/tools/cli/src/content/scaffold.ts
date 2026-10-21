/**
 * The YAML `adminforge new` writes: one generator per kind (page, dashboard, report, playbook, runbook, connection,
 * probe, schedule) and page template (list-detail, dashboard, report, entity), each producing a definition that
 * validates as written — `$schema` for editor autocomplete, `TODO`s where the author decides, injection-safe
 * expressions — plus, where there is a datasource, a synthetic fixture body for DATA_MODE=fixtures.
 *
 * Pure (returns text and paths; commands/new.ts checks and writes them). Change the templates here when the content
 * conventions change, and keep tests/unit/cli/content.test.ts ("scaffolds every kind and template…") passing.
 */
import path from 'node:path';

/** Kinds `adminforge new` scaffolds, and their folder under portal/content. */
export const SCAFFOLD_KINDS = {
  page: 'pages',
  dashboard: 'dashboards',
  report: 'reports',
  playbook: 'playbooks',
  runbook: 'runbooks',
  connection: 'connections',
  probe: 'probes',
  schedule: 'schedules',
  feed: 'feeds',
} as const;
export type ScaffoldKind = keyof typeof SCAFFOLD_KINDS;
export const PAGE_TEMPLATES = ['list-detail', 'dashboard', 'report', 'entity'] as const;
export type PageTemplate = (typeof PAGE_TEMPLATES)[number];

export interface ScaffoldInput {
  kind: ScaffoldKind;
  /** `<section>/<name>` in kebab case. */
  target: string;
  template?: PageTemplate;
  owner?: string;
  /** Navigation sections declared in navigation.yaml (nav is added only when the section exists). */
  navSections: ReadonlySet<string>;
  /** Absolute paths. */
  contentDir: string;
  schemasDir: string;
}

export interface Scaffold {
  id: string;
  /** Absolute path of the YAML file. */
  file: string;
  yaml: string;
  /** Request whose response the fixture stub answers (fixture mode), or undefined. */
  fixture?: { method: string; url: string; body: unknown };
  template?: PageTemplate;
  navAdded: boolean;
}

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** A synthetic object id used by entity templates and their fixture stubs. */
export const SAMPLE_ID = '00000000-0000-4000-8000-000000000001';

export const titleOf = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' ');

export function parseTarget(target: string): { section: string; name: string } {
  const parts = target.replace(/\.(ya?ml)$/, '').split('/');
  if (parts.length !== 2 || !KEBAB.test(parts[0]!) || !KEBAB.test(parts[1]!))
    throw new Error(
      `Expected <section>/<name> in lower-case kebab case (e.g. identity/stale-guests), got "${target}".`,
    );
  return { section: parts[0]!, name: parts[1]! };
}

const navLine = (show: boolean, section: string, title: string, icon: string) =>
  show ? `nav: { section: ${section}, label: ${title}, icon: ${icon}, order: 100 }\n` : '';

function pageYaml(
  kind: 'page' | 'dashboard' | 'report',
  template: PageTemplate,
  h: { header: string; nav: (icon: string) => string; name: string },
): { body: string; fixture?: Scaffold['fixture'] } {
  const graph = 'https://graph.microsoft.com/v1.0';
  if (template === 'entity') {
    return {
      body: `${h.header}template: entity
requires:
  portalRoles: [Portal.Reader]
  scopes:
    graph: [Group.Read.All]

params:
  id: { type: guid, label: Group, required: true, hidden: true }

datasources:
  item:
    source: graph
    request:
      path: /groups/\${ $encode($guid(params.id)) }
      query:
        $select: id,displayName,description,mail,securityEnabled,groupTypes,createdDateTime
    cache: { ttl: 30 }

header:
  title: \${ item.displayName }
  subtitle: \${ item.mail }
  ids:
    Object id: \${ item.id }

tabs:
  - id: overview
    label: Overview
    layout:
      - widget: keyValue
        span: 12
        data: item
        fields:
          - { field: description, label: Description }
          - { field: securityEnabled, label: Security, kind: boolean }
          - { field: createdDateTime, label: Created, kind: datetime }
`,
      fixture: {
        method: 'GET',
        url: `${graph}/groups/${SAMPLE_ID}`,
        body: {
          id: SAMPLE_ID,
          displayName: 'Example Group 1',
          description: 'Synthetic fixture',
          mail: null,
          securityEnabled: true,
          groupTypes: [],
          createdDateTime: '2026-01-15T12:00:00Z',
        },
      },
    };
  }
  if (template === 'dashboard') {
    return {
      body: `${h.header}${kind === 'page' ? 'template: dashboard\n' : ''}${h.nav('gauge')}requires:
  portalRoles: [Portal.Reader]
  scopes:
    graph: [User.Read.All, Group.Read.All, Application.Read.All]

datasources:
  counts:
    source: graphBatch
    requests:
      users: { path: /users/$count, headers: { ConsistencyLevel: eventual } }
      groups: { path: /groups/$count, headers: { ConsistencyLevel: eventual } }
      apps: { path: /applications/$count, headers: { ConsistencyLevel: eventual } }
    cache: { ttl: 300 }

layout:
  - { widget: kpi, span: 4, data: counts.users, label: Users }
  - { widget: kpi, span: 4, data: counts.groups, label: Groups }
  - { widget: kpi, span: 4, data: counts.apps, label: App registrations }
`,
      fixture: { method: 'GET', url: `${graph}/users/$count`, body: 42 },
    };
  }
  if (template === 'report') {
    return {
      body: `${h.header}${kind === 'page' ? 'template: list-detail\n' : ''}${h.nav('chart-bar')}requires:
  portalRoles: [Portal.Reader]
  scopes:
    graph: [Group.Read.All]

params:
  days: { type: number, default: 30, min: 1, max: 365, integer: true, label: Created within (days), facet: true }

datasources:
  groups:
    source: graph
    request:
      path: /groups
      query:
        $select: id,displayName,mail,securityEnabled,createdDateTime
        $top: 999
    paging: all
    maxItems: 20000
    cache: { ttl: 300 }
    # value = { value: [groups] } → rows created within the window, newest first.
    transform: >-
      \${ (
        $since := $daysAgo(params.days);
        $rows := [value.value[createdDateTime >= $since]^(>createdDateTime)];
        { "rows": $rows, "total": $count($rows) }
      ) }

layout:
  - widget: kpi
    data: groups.total
    label: Groups in this report
  - widget: table
    id: groups
    span: 12
    data: groups.rows
    rowKey: id
    columns:
      - { field: displayName, label: Group, kind: identity, secondary: mail }
      - { field: securityEnabled, label: Security, kind: boolean, filter: facet }
      - { field: createdDateTime, label: Created, kind: datetime, filter: date }
      - { field: id, label: Object id, kind: guid, hidden: true }

export:
  formats: [csv, xlsx]
  fileName: ${h.name}-\${ params.days }d
  data: groups.rows
  columns: all
`,
      fixture: { method: 'GET', url: `${graph}/groups`, body: { value: [] } },
    };
  }
  return {
    body: `${h.header}template: list-detail
${h.nav('list')}requires:
  portalRoles: [Portal.Reader]
  scopes:
    graph: [Group.Read.All]

params:
  q: { type: string, default: "", label: Search, placeholder: Name }
  type: { type: enum, values: [All, Security, Microsoft365], default: All, label: Type, facet: true }

filters:
  search: q
  facets: [type]

savedViews:
  enabled: true
  shared: true

datasources:
  items:
    source: graph
    request:
      path: /groups
      headers: { ConsistencyLevel: eventual }
      query:
        $select: id,displayName,description,mail,securityEnabled,groupTypes,createdDateTime
        $count: true
        $top: 100
        # User input reaches $filter / $search only through $odata() / $odataSearch().
        $filter: >-
          \${ params.type = 'Security' ? "securityEnabled eq true" : params.type = 'Microsoft365' ? "groupTypes/any(t:t eq 'Unified')" }
        $search: >-
          \${ params.q ? '"displayName:' & $odataSearch(params.q) & '"' }
    paging: cursor
    cache: { ttl: 60 }

layout:
  - widget: table
    id: items
    span: 12
    data: items.value
    rowKey: id
    selection: multi
    columns:
      - { field: displayName, label: Name, kind: identity, secondary: mail }
      - { field: description, label: Description }
      - { field: securityEnabled, label: Security, kind: boolean, filter: facet }
      - { field: createdDateTime, label: Created, kind: date, filter: date }
      - { field: id, label: Object id, kind: guid, hidden: true }

export:
  formats: [csv, xlsx]
  fileName: ${h.name}
  data: items.value
  columns: visible
`,
    fixture: { method: 'GET', url: `${graph}/groups`, body: { value: [] } },
  };
}

/** YAML for a new definition (validated by the caller before it is written). */
export function scaffold(input: ScaffoldInput): Scaffold {
  const { section, name } = parseTarget(input.target);
  const id = `${section}.${name}`;
  const kind = input.kind;
  // The folder is the id prefix; ids named after their kind folder (feeds.<name>, probes.<name>) live directly in it
  // (feeds/, not feeds/feeds/) — where `adminforge validate` expects them (content/check.ts `expectedFolder`).
  const dir =
    section === SCAFFOLD_KINDS[kind]
      ? path.join(input.contentDir, SCAFFOLD_KINDS[kind])
      : path.join(input.contentDir, SCAFFOLD_KINDS[kind], section);
  const file = path.join(dir, `${name}.${kind}.yaml`);
  const schemaRef = path
    .relative(path.dirname(file), path.join(input.schemasDir, `${kind}.schema.json`))
    .split(path.sep)
    .join('/');
  const title = titleOf(name);
  const owner = input.owner ?? `${section}-team`;
  const header = `$schema: ${schemaRef}
kind: ${kind}
id: ${id}
version: 0.1.0
title: ${title}
summary: TODO — one sentence on what this ${kind} is for.
owner: ${owner}
tags: [${section}]
`;
  const hasNav = input.navSections.has(section);
  const nav = (icon: string) => navLine(hasNav, section, title, icon);

  if (kind === 'page' || kind === 'dashboard' || kind === 'report') {
    const template: PageTemplate = input.template ?? (kind === 'page' ? 'list-detail' : kind);
    if (kind === 'dashboard' && template !== 'dashboard')
      throw new Error('Dashboards use --template dashboard.');
    if (kind === 'report' && template !== 'report') throw new Error('Reports use --template report.');
    const { body, fixture } = pageYaml(kind, template, { header, nav, name });
    return { id, file, yaml: body, fixture, template, navAdded: hasNav && template !== 'entity' };
  }
  if (input.template) throw new Error(`--template applies to pages, dashboards and reports, not ${kind}s.`);

  if (kind === 'playbook') {
    return {
      id,
      file,
      navAdded: false,
      fixture: {
        method: 'GET',
        url: `https://graph.microsoft.com/v1.0/users/${SAMPLE_ID}`,
        body: {
          id: SAMPLE_ID,
          displayName: 'Example User 1',
          userPrincipalName: 'user1@example.com',
          accountEnabled: true,
        },
      },
      yaml: `${header}risk: low
mode: read
requires:
  portalRoles: [Portal.Reader]
  scopes:
    graph: [User.Read.All]

inputs:
  userId: { type: string, format: guid, label: User, picker: user }

steps:
  - id: lookup
    type: graph
    request:
      method: GET
      path: /users/\${ $encode($guid(inputs.userId)) }
      query: { $select: "id,displayName,userPrincipalName,accountEnabled" }

  - id: check
    type: assert
    that: \${ steps.lookup.output.accountEnabled = true }
    message: \${ steps.lookup.output.userPrincipalName & ' cannot sign in.' }

outputs:
  summary: \${ steps.lookup.output.displayName & ' can sign in.' }

tests:
  - name: passes for an enabled account
    inputs: { userId: ${SAMPLE_ID} }
    mocks: { lookup: { id: ${SAMPLE_ID}, displayName: Example User 1, userPrincipalName: user1@example.com, accountEnabled: true } }
    expect: { status: succeeded, outputs: { summary: Example User 1 can sign in. } }
  - name: fails for a disabled account
    inputs: { userId: ${SAMPLE_ID} }
    mocks: { lookup: { id: ${SAMPLE_ID}, displayName: Example User 1, userPrincipalName: user1@example.com, accountEnabled: false } }
    expect: { status: failed, failedStep: check }
`,
    };
  }
  if (kind === 'runbook') {
    return {
      id,
      file,
      navAdded: false,
      yaml: `${header}risk: low
mode: read
requires:
  portalRoles: [Portal.Reader]

sections:
  - id: triage
    title: Triage
    body: |
      What the engineer checks first, and why.
    steps:
      - id: confirm
        type: manual
        instructions: Confirm the ticket number and who is affected.
        checklist: [Ticket opened, Affected people contacted]
`,
    };
  }
  if (kind === 'connection') {
    return {
      id,
      file,
      navAdded: false,
      fixture: {
        method: 'GET',
        url: 'https://func-example.example.com/api/health',
        body: { status: 'Healthy' },
      },
      yaml: `${header}# Endpoint and audience are placeholders: reference env keys (declared in config/example.env) for real values.
baseUrl: https://func-example.example.com/api
audience: api://${SAMPLE_ID}
operations:
  health: { method: GET, path: /health, mode: read, description: Liveness check }
health: health
`,
    };
  }
  if (kind === 'probe') {
    // Synthetic monitoring groups probes by service: the section when it is one, else a placeholder to fill in.
    const group = hasNav
      ? `group: ${section}\n`
      : '# group: <navigation section key, or platform> — where Synthetic monitoring lists it\n';
    return {
      id,
      file,
      navAdded: false,
      yaml: `${header}${group}check:
  kind: graph
  path: /organization
  query:
    $select: id
  expect:
    status: 200
thresholds: { warn: 1500, crit: 5000 }
intervalHint: PT5M
timeoutMs: 15000
requires:
  scopes:
    graph: [Organization.Read.All]
`,
    };
  }
  if (kind === 'feed') {
    const url = 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=example-board';
    return {
      id,
      file,
      navAdded: false,
      fixture: {
        method: 'GET',
        url,
        body: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Example board</title><link>https://techcommunity.microsoft.com/</link>
<item><title>Example: a change to an example service</title><link>https://techcommunity.microsoft.com/t5/example/ba-p/1</link>
<guid>https://techcommunity.microsoft.com/t5/example/ba-p/1</guid><pubDate>Mon, 12 Oct 2026 09:00:00 GMT</pubDate>
<description>Synthetic item for DATA_MODE=fixtures.</description></item></channel></rss>
`,
      },
      yaml: `${header}# News and changes feed (docs/news.md). First-party sources only; the URL's host must be in NEWS_FEED_HOSTS
# (portal/packages/schemas/src/news.ts) — adding a host is a reviewed code change. Draft until reviewed: the news job
# skips drafts. Then set status: active (or remove it).
status: draft
publisher: Microsoft
homepage: https://techcommunity.microsoft.com/
collector:
  kind: rss
  url: ${url}
  lookbackDays: 90
# keep: matched + rules that set areas keeps only items about services AdminForge manages (preferred for broad feeds).
keep: all
defaultAreas: [platform]
classify:
  - match: { title: [retirement, deprecation, end of support] }
    kind: retirement
pollMinutes: 360
`,
    };
  }
  return {
    id,
    file,
    navAdded: false,
    yaml: `${header}# Runs as the automation identity (ADR-011). Enable after review.
cron: "0 6 * * *"
timezone: UTC
enabled: false
identity: automation
job:
  kind: contentHealth
  scopes: true
`,
  };
}
