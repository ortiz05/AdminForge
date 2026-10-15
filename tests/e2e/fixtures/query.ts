/**
 * Query Studio fixtures: synthetic only (Example Org, generated GUIDs). One answer function serves both the
 * component tests (fetch stub) and Playwright (page.route handler), keyed off the request body like the BFF would.
 */

export const QIDS = {
  subProd: '82980163-74fc-4da9-ae3c-ab5bac5b3365',
  subDev: 'c6256fe9-f716-4e27-b88c-9f165b7f6078',
  workspace: 'ce5b9294-be83-4bd6-affe-e14f1d7fc60e',
  workspaceOps: '250c5627-e39b-436d-91e8-0510e54dc6b0',
  correlation: '1286d1c7-1e20-42d6-8ecf-6146de58a3fc',
  activity1: '0a469cdb-0f6d-4fab-902c-2adab092eb8a',
  activity2: '19a38956-eca1-4f23-8306-93b9483607c4',
  activity3: '623eb85e-dbb9-44f2-a937-65f9faa533e5',
} as const;

const provenance = (service: string, path: string, ms: number) => ({ service, path, ms, requestId: QIDS.correlation });

export const subscriptionsResult = () => ({
  columns: [
    { name: 'subscriptionId', type: 'string' },
    { name: 'name', type: 'string' },
  ],
  rows: [
    { subscriptionId: QIDS.subDev, name: 'Example Development' },
    { subscriptionId: QIDS.subProd, name: 'Example Production' },
  ],
  rowCount: 2,
  truncated: false,
  ms: 210,
  provenance: provenance('resourceGraph', '/providers/Microsoft.ResourceGraph/resources', 210),
});

export const workspacesResult = () => ({
  columns: [
    { name: 'name', type: 'string' },
    { name: 'customerId', type: 'string' },
    { name: 'resourceGroup', type: 'string' },
  ],
  rows: [
    { name: 'law-example-ops', customerId: QIDS.workspaceOps, resourceGroup: 'rg-operations' },
    { name: 'law-example-prod', customerId: QIDS.workspace, resourceGroup: 'rg-monitoring' },
  ],
  rowCount: 2,
  truncated: false,
  ms: 190,
  provenance: provenance('resourceGraph', '/providers/Microsoft.ResourceGraph/resources', 190),
});

const INVENTORY: Array<[string, string, number]> = [
  ['microsoft.compute/virtualmachines', 'eastus', 48],
  ['microsoft.network/networkinterfaces', 'eastus', 52],
  ['microsoft.compute/disks', 'eastus', 61],
  ['microsoft.storage/storageaccounts', 'eastus', 23],
  ['microsoft.compute/virtualmachines', 'westeurope', 19],
  ['microsoft.network/networksecuritygroups', 'eastus', 17],
  ['microsoft.web/sites', 'westeurope', 14],
  ['microsoft.keyvault/vaults', 'eastus', 9],
  ['microsoft.hybridcompute/machines', 'westeurope', 27],
  ['microsoft.storage/storageaccounts', 'westeurope', 11],
  ['microsoft.operationalinsights/workspaces', 'eastus', 3],
  ['microsoft.network/publicipaddresses', 'eastus', 8],
];

export const inventoryResult = () => ({
  columns: [
    { name: 'type', type: 'string' },
    { name: 'location', type: 'string' },
    { name: 'resources', type: 'long' },
  ],
  rows: INVENTORY.map(([type, location, resources]) => ({ type, location, resources })),
  rowCount: INVENTORY.length,
  truncated: false,
  ms: 1240,
  provenance: provenance('resourceGraph', '/providers/Microsoft.ResourceGraph/resources', 1240),
});

/** Untagged resources, cut off by the service (truncated). */
export const untaggedResult = () => ({
  columns: [
    { name: 'name', type: 'string' },
    { name: 'type', type: 'string' },
    { name: 'resourceGroup', type: 'string' },
    { name: 'location', type: 'string' },
    { name: 'subscriptionId', type: 'string' },
    { name: 'id', type: 'string' },
  ],
  rows: Array.from({ length: 40 }, (_, i) => {
    const name = `vm-example-${String(i + 1).padStart(3, '0')}`;
    const rg = i % 2 ? 'rg-app-prod' : 'rg-web-prod';
    return {
      name,
      type: 'microsoft.compute/virtualmachines',
      resourceGroup: rg,
      location: i % 3 ? 'eastus' : 'westeurope',
      subscriptionId: QIDS.subProd,
      id: `/subscriptions/${QIDS.subProd}/resourceGroups/${rg}/providers/Microsoft.Compute/virtualMachines/${name}`,
    };
  }),
  rowCount: 1312,
  truncated: true,
  ms: 2310,
  provenance: provenance('resourceGraph', '/providers/Microsoft.ResourceGraph/resources', 2310),
});

export const activityResult = () => ({
  columns: [
    { name: 'TimeGenerated', type: 'datetime' },
    { name: 'Caller', type: 'string' },
    { name: 'OperationNameValue', type: 'string' },
    { name: 'ActivitySubstatusValue', type: 'string' },
    { name: 'ResourceGroup', type: 'string' },
    { name: 'CorrelationId', type: 'guid' },
  ],
  rows: [
    {
      TimeGenerated: '2026-10-15T13:41:07Z',
      Caller: 'deploy.pipeline@example.com',
      OperationNameValue: 'MICROSOFT.RESOURCES/DEPLOYMENTS/WRITE',
      ActivitySubstatusValue: 'Conflict',
      ResourceGroup: 'RG-APP-PROD',
      CorrelationId: QIDS.activity1,
    },
    {
      TimeGenerated: '2026-10-15T12:02:51Z',
      Caller: 'a.lee@example.com',
      OperationNameValue: 'MICROSOFT.KEYVAULT/VAULTS/WRITE',
      ActivitySubstatusValue: 'Forbidden',
      ResourceGroup: 'RG-SECURITY',
      CorrelationId: QIDS.activity2,
    },
    {
      TimeGenerated: '2026-10-15T09:17:33Z',
      Caller: 'm.chen@example.com',
      OperationNameValue: 'MICROSOFT.NETWORK/NETWORKSECURITYGROUPS/SECURITYRULES/DELETE',
      ActivitySubstatusValue: 'Forbidden',
      ResourceGroup: 'RG-NETWORK',
      CorrelationId: QIDS.activity3,
    },
  ],
  rowCount: 3,
  truncated: false,
  ms: 860,
  provenance: provenance('logAnalytics', '/v1/workspaces/{id}/query', 860),
});

const CALLERS = ['deploy.pipeline@example.com', 'a.lee@example.com', 'm.chen@example.com'];
export const changesTrendResult = () => ({
  columns: [
    { name: 'TimeGenerated', type: 'datetime' },
    { name: 'Caller', type: 'string' },
    { name: 'changes', type: 'long' },
  ],
  rows: Array.from({ length: 12 }, (_, h) =>
    CALLERS.map((Caller, c) => ({
      TimeGenerated: new Date(Date.UTC(2026, 9, 15, h + 2)).toISOString(),
      Caller,
      changes: [14, 6, 3][c]! + ((h * (c + 3)) % 7),
    })),
  ).flat(),
  rowCount: 36,
  truncated: false,
  ms: 640,
  provenance: provenance('logAnalytics', '/v1/workspaces/{id}/query', 640),
});

export const printResult = () => ({
  columns: [
    { name: 'workspace', type: 'string' },
    { name: 'checkedAt', type: 'datetime' },
  ],
  rows: [{ workspace: 'reachable', checkedAt: '2026-10-15T14:00:00Z' }],
  rowCount: 1,
  truncated: false,
  ms: 120,
  provenance: provenance('logAnalytics', '/v1/workspaces/{id}/query', 120),
});

export const huntingResult = () => ({
  columns: [
    { name: 'OSPlatform', type: 'string' },
    { name: 'OnboardingStatus', type: 'string' },
    { name: 'devices', type: 'long' },
  ],
  rows: [
    { OSPlatform: 'Windows11', OnboardingStatus: 'Onboarded', devices: 412 },
    { OSPlatform: 'Windows10', OnboardingStatus: 'Onboarded', devices: 133 },
    { OSPlatform: 'macOS', OnboardingStatus: 'Onboarded', devices: 61 },
    { OSPlatform: 'Windows10', OnboardingStatus: 'Can be onboarded', devices: 18 },
  ],
  rowCount: 4,
  truncated: false,
  ms: 1530,
  provenance: provenance('graph', '/security/runHuntingQuery', 1530),
});

export const QUERY_ERROR = {
  error: {
    code: 'invalid_query',
    message: "Resource Graph couldn't parse the query: 'summarise' is not a recognised operator (line 2, column 3).",
    hint: 'Check the operator name — KQL uses summarize — then run it again.',
    correlationId: QIDS.correlation,
  },
};

export const CAPABILITIES_NO_DEFENDER = {
  roles: { active: [], eligible: [], eligibleAvailable: false, activeSource: 'assignments' },
  features: {
    defender: {
      available: false,
      reason: 'Requires Microsoft Defender XDR / Defender for Endpoint (MTP or WINDEFATP)',
      sku: 'MTP',
      label: 'Microsoft Defender (incidents and alerts)',
      servicePlans: ['MTP', 'WINDEFATP'],
    },
  },
};

export function scaffoldResult(body: { as?: string; title?: string; source?: string; query?: string }) {
  const kind = body.as ?? 'report';
  const slug = (body.title ?? 'query')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const folder = kind === 'report' ? 'reports/azure' : kind === 'probe' ? 'probes' : 'schedules/reports';
  const path = `portal/content/${folder}/${slug}.${kind}.yaml`;
  const yaml = [
    `$schema: ../../../packages/schemas/generated/${kind}.schema.json`,
    `kind: ${kind}`,
    `id: azure.${slug}`,
    'version: 1.0.0',
    `title: ${body.title}`,
    'owner: azure-team',
    'datasources:',
    '  rows:',
    `    source: ${body.source}`,
    '    query: |',
    ...(body.query ?? '').split('\n').map((l) => `      ${l}`),
  ].join('\n');
  return { yaml: `${yaml}\n`, path, key: `azure.${slug}` };
}

export interface QueryReply {
  status: number;
  body: unknown;
}

/** What the mock BFF answers for POST /api/query and POST /api/query/scaffold. */
export function answerQuery(path: string, body: Record<string, unknown>): QueryReply | undefined {
  if (path === '/api/query/scaffold') return { status: 200, body: scaffoldResult(body) };
  if (path !== '/api/query') return undefined;
  const q = String(body.query ?? '');
  if (/summarise/.test(q)) return { status: 400, body: QUERY_ERROR };
  if (body.source === 'resourceGraph') {
    if (/resourcecontainers/.test(q) && /subscriptions/.test(q)) return { status: 200, body: subscriptionsResult() };
    if (/operationalinsights\/workspaces/.test(q)) return { status: 200, body: workspacesResult() };
    if (/bag_keys\(tags\)/.test(q)) return { status: 200, body: untaggedResult() };
    if (/where name == 'nothing'/.test(q)) return { status: 200, body: { ...inventoryResult(), rows: [], rowCount: 0, ms: 95 } };
    return { status: 200, body: inventoryResult() };
  }
  if (body.source === 'logAnalytics') {
    if (/^\s*print\b/.test(q)) return { status: 200, body: printResult() };
    if (/bin\(TimeGenerated/.test(q)) return { status: 200, body: changesTrendResult() };
    return { status: 200, body: activityResult() };
  }
  if (body.source === 'advancedHunting') return { status: 200, body: huntingResult() };
  return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown source.' } } };
}
