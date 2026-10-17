/**
 * A deterministic synthetic enterprise tenant for the perf suite and load test (tests/perf/README.md). Synthetic only:
 * `example.com` names, generated GUIDs — never a real tenant. One seed + one scale always give the same tenant.
 *
 * Scale `enterprise` (the default): 100k users (8% guests), 50k groups (one 100k-member "All Company" group, nested,
 * dynamic, Microsoft 365 with teams, ownerless and empty ones), 30k Intune managed devices and 36k Entra devices, 20k
 * app registrations with their service principals, 1M sign-ins and 100k directory audit events a day for 30 days
 * (generated lazily, never held in memory), usage report rows per user, site and team, Intune policies and apps, role
 * assignments and PIM. Tricky values are part of the data: apostrophes (O'Brien), non-Latin names, very long names.
 *
 * Group membership costs no memory: a group's members are `(start + k·stride) mod users` for k < count, with `stride`
 * coprime to the user count, so "is user u a member" is one modular multiplication (memberOf scans the groups).
 */
import { type Collection, type GraphObject, IdIndex, materialised, virtual } from './collection';
import { guid, hash32, unit } from './prng';

export const NOW_ISO = '2026-10-15T12:00:00.000Z';
export const NOW_MS = Date.parse(NOW_ISO);
const DAY = 86_400_000;

export interface Scale {
  name: string;
  users: number;
  groups: number;
  managedDevices: number;
  entraDevices: number;
  apps: number;
  signInsPerDay: number;
  auditsPerDay: number;
  sites: number;
}

export const SCALES: Record<string, Scale> = {
  enterprise: {
    name: 'enterprise',
    users: 100_000,
    groups: 50_000,
    managedDevices: 30_000,
    entraDevices: 36_000,
    apps: 20_000,
    signInsPerDay: 1_000_000,
    auditsPerDay: 100_000,
    sites: 50_000,
  },
  large: {
    name: 'large',
    users: 20_000,
    groups: 10_000,
    managedDevices: 6_000,
    entraDevices: 7_000,
    apps: 4_000,
    signInsPerDay: 200_000,
    auditsPerDay: 20_000,
    sites: 10_000,
  },
  small: {
    name: 'small',
    users: 2_000,
    groups: 800,
    managedDevices: 600,
    entraDevices: 700,
    apps: 300,
    signInsPerDay: 20_000,
    auditsPerDay: 2_000,
    sites: 600,
  },
};

const LOG_DAYS = 30;

// --- name material (synthetic; includes the cases that break naive escaping and layout) ---
const FIRST = [
  'Avery',
  'Blake',
  'Casey',
  'Dana',
  'Eli',
  'Frankie',
  'Gale',
  'Harper',
  'Indy',
  'Jordan',
  'Kai',
  'Logan',
  'Morgan',
  'Noa',
  'Oakley',
  'Parker',
  'Quinn',
  'Riley',
  'Sage',
  'Taylor',
  'Uma',
  'Val',
  'Wren',
  'Xan',
  'Yael',
  'Zion',
  'José',
  'Zoë',
  'Søren',
  'Ælfric',
  'Łucja',
  'Jürgen',
  'François',
  'Siobhán',
  'Ngozi',
  'Aroha',
  '张伟',
  '李娜',
  'さくら',
  '지민',
  'Јован',
  'Ελένη',
  'محمد',
  'דנה',
  'अनन्या',
];
const LAST = [
  "O'Brien",
  "D'Angelo",
  "O'Connor",
  'Smith',
  'Chen',
  'Garcia',
  'Nguyen',
  'Kowalski',
  'Müller',
  'Okafor',
  'Haddad',
  'Rossi',
  'Tanaka',
  'Kim',
  'Novak',
  'Silva',
  'Andersen',
  'Dubois',
  'Ivanova',
  'Papadopoulos',
  'MacLeod',
  'van der Berg',
  'de la Cruz',
  'Ó Súilleabháin',
  'Đorđević',
  'Wolfeschlegelsteinhausenbergerdorff',
  '王',
  '佐藤',
  'Петров',
];
const DEPARTMENTS = [
  'Engineering',
  'Finance',
  'Sales',
  'Marketing',
  'HR',
  'Legal',
  'Operations',
  'Support',
  'IT',
  'Security',
  'R&D',
  'Procurement',
  'Facilities',
  'Manufacturing',
  'Logistics',
  'Customer Success',
  'Data & Analytics',
  'Design',
  'Product',
  'Executive Office',
  "Partners' Desk",
  'Research — Europe',
  'Quality',
  'Compliance',
  'Treasury',
];
const COUNTRIES: ReadonlyArray<readonly [string | null, number]> = [
  ['US', 50],
  ['GB', 15],
  ['DE', 10],
  ['IN', 10],
  ['AU', 5],
  ['JP', 5],
  [null, 5],
];
const CITIES: Record<string, string[]> = {
  US: ['Seattle', 'New York', 'Austin'],
  GB: ['London', 'Manchester'],
  DE: ['Berlin', 'München'],
  IN: ['Bengaluru', 'Pune'],
  AU: ['Sydney'],
  JP: ['東京', 'Osaka'],
};

const ascii = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase();

const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const dateOnly = (ms: number) => iso(ms).slice(0, 10);

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}
function modInverse(a: number, m: number): number {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1, 0];
  while (r) {
    const q = Math.floor(oldR / r);
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

/** Microsoft-published role template ids content refers to (the same in every tenant). */
export const ROLE_TEMPLATES: ReadonlyArray<readonly [string, string, boolean]> = [
  ['62e90394-69f5-4237-9190-012177145e10', 'Global Administrator', true],
  ['e8611ab8-c189-46e8-94e1-60213ab1f814', 'Privileged Role Administrator', true],
  ['194ae4cb-b126-40b2-bd5b-6091b380977d', 'Security Administrator', true],
  ['29232cdf-9323-42fd-ade2-1d097af3e4de', 'Exchange Administrator', true],
  ['f28a1f50-f6e7-4571-818b-6a12f2af6b6c', 'SharePoint Administrator', true],
  ['fe930be7-5e62-47db-91af-98c3a49a38b1', 'User Administrator', true],
  ['729827e3-9c14-49f7-bb1b-9608f156bbb8', 'Helpdesk Administrator', false],
  ['f2ef992c-3afb-46b9-b7cf-a126ee74c451', 'Global Reader', false],
  ['9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3', 'Application Administrator', true],
  ['158c047a-c907-4556-b7ef-446551a6b5f7', 'Cloud Application Administrator', true],
  ['3a2c62db-5318-420d-8d74-23affee5d9d5', 'Intune Administrator', true],
  ['b0f54661-2d74-4c50-afa3-1ec803f12efe', 'Billing Administrator', false],
  ['4a5d8f65-41da-4de4-8968-e035b65339cf', 'Reports Reader', false],
  ['5d6b6bb7-de71-4623-b4af-96380a352509', 'Security Reader', false],
  ['790c1fb9-7f7d-4f88-86a1-ef1f95c05c1b', 'Message Center Reader', false],
  ['b1be1c3e-b65d-4f19-8427-f6fa0d97feb9', 'Conditional Access Administrator', true],
  ['c4e39bd9-1100-46d3-8c65-fb160da0071f', 'Authentication Administrator', true],
  ['7be44c8a-adaf-4e2a-84d6-ab2649e08a13', 'Privileged Authentication Administrator', true],
  ['966707d0-3269-4727-9be2-8c3a10f19b9d', 'Password Administrator', false],
  ['5f2222b1-57c3-48ba-8ad5-d4759f1fde6f', 'Security Operator', false],
];

export const GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
export const EXCHANGE_APP_ID = '00000002-0000-0ff1-ce00-000000000000';
export const SHAREPOINT_APP_ID = '00000003-0000-0ff1-ce00-000000000000';

const GRAPH_ROLES = [
  'User.Read.All',
  'Directory.Read.All',
  'Group.Read.All',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Files.ReadWrite.All',
  'Sites.FullControl.All',
  'Directory.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
  'Application.ReadWrite.All',
  'AppRoleAssignment.ReadWrite.All',
  'AuditLog.Read.All',
  'Reports.Read.All',
  'DeviceManagementManagedDevices.Read.All',
  'User.ReadWrite.All',
  'Group.ReadWrite.All',
  'Calendars.Read',
];

export interface SyntheticTenant {
  scale: Scale;
  seed: number;
  ids: IdIndex;
  organization: GraphObject;
  domains: GraphObject[];
  users: GraphObject[];
  /** Manager index per user (-1 = none). */
  managerOf: Int32Array;
  groups: GraphObject[];
  /** Index of the 100k-member "All Company" group (0). */
  allCompany: number;
  groupUserMembers(g: number): { count: number; at(k: number): number };
  groupHasUser(g: number, u: number): boolean;
  nestedGroups: Map<number, number[]>;
  groupOwners: number[][];
  userGroups(u: number): number[];
  managedDevices: GraphObject[];
  entraDevices: GraphObject[];
  deviceOwner: Int32Array;
  applications: GraphObject[];
  servicePrincipals: GraphObject[];
  /** App owners (user indexes) per application. */
  appOwners: number[][];
  subscribedSkus: GraphObject[];
  roleDefinitions: GraphObject[];
  roleAssignments: GraphObject[];
  roleEligibilities: GraphObject[];
  signIns: Collection;
  directoryAudits: Collection;
  riskyUsers: GraphObject[];
  riskDetections: Collection;
  userRegistrationDetails: Collection;
  oauth2PermissionGrants: Collection;
  graphAppRoleAssignedTo: Collection;
  compliancePolicies: GraphObject[];
  deviceConfigurations: GraphObject[];
  configurationPolicies: GraphObject[];
  mobileApps: GraphObject[];
  autopilotDevices: Collection;
  settingStateSummaries: GraphObject[];
  teams: number[];
  sites: Collection;
  serviceIssues: GraphObject[];
  serviceMessages: GraphObject[];
  healthOverviews: GraphObject[];
  caPolicies: GraphObject[];
  namedLocations: GraphObject[];
  singletons: Record<string, GraphObject>;
  usageReport(name: string): Collection | undefined;
  detectedApps(device: number): Collection;
  bitlockerKeys: Collection;
}

export function createTenant(scale: Scale = SCALES.enterprise!, seed = 20261017): SyntheticTenant {
  const ids = new IdIndex();
  const N = scale.users;
  const tenantId = guid(1, 0);

  const organization: GraphObject = {
    id: tenantId,
    displayName: 'Example Org',
    countryLetterCode: 'US',
    verifiedDomains: [
      {
        name: 'example.com',
        isDefault: true,
        isInitial: false,
        type: 'Managed',
        capabilities: 'Email, OfficeCommunicationsOnline',
      },
      {
        name: 'example.onmicrosoft.com',
        isDefault: false,
        isInitial: true,
        type: 'Managed',
        capabilities: 'Email',
      },
    ],
    onPremisesSyncEnabled: true,
    onPremisesLastSyncDateTime: iso(NOW_MS - 25 * 60_000),
    createdDateTime: '2015-03-01T09:00:00Z',
    assignedPlans: [],
    tenantType: 'AAD',
  };
  const domains: GraphObject[] = [
    {
      id: 'example.com',
      isDefault: true,
      isVerified: true,
      authenticationType: 'Managed',
      supportedServices: ['Email', 'OfficeCommunicationsOnline'],
    },
    {
      id: 'example.onmicrosoft.com',
      isDefault: false,
      isVerified: true,
      isInitial: true,
      authenticationType: 'Managed',
      supportedServices: ['Email'],
    },
    {
      id: 'sales.example.com',
      isDefault: false,
      isVerified: true,
      authenticationType: 'Managed',
      supportedServices: ['Email'],
    },
    {
      id: 'legacy.example.com',
      isDefault: false,
      isVerified: false,
      authenticationType: 'Federated',
      supportedServices: [],
    },
  ];

  // --- licences ---
  const skuDefs: Array<[string, number, string[]]> = [
    [
      'SPE_E5',
      Math.round(N * 0.42),
      [
        'AAD_PREMIUM',
        'AAD_PREMIUM_P2',
        'INTUNE_A',
        'EXCHANGE_S_ENTERPRISE',
        'TEAMS1',
        'SHAREPOINTENTERPRISE',
        'MTP',
      ],
    ],
    [
      'SPE_E3',
      Math.round(N * 0.5),
      ['AAD_PREMIUM', 'INTUNE_A', 'EXCHANGE_S_ENTERPRISE', 'TEAMS1', 'SHAREPOINTENTERPRISE'],
    ],
    ['SPE_F1', Math.round(N * 0.1), ['AAD_PREMIUM', 'INTUNE_A', 'EXCHANGE_S_DESKLESS', 'TEAMS1']],
    ['POWER_BI_PRO', Math.round(N * 0.2), ['BI_AZURE_P2']],
    ['VISIOCLIENT', 800, ['VISIO_CLIENT_SUBSCRIPTION']],
    ['PROJECTPROFESSIONAL', 400, ['PROJECT_PROFESSIONAL']],
    ['Microsoft_365_Copilot', 1500, ['M365_COPILOT_APPS']],
    ['FLOW_FREE', 10_000, ['FLOW_P2_VIRAL']],
    ['WIN_DEF_ATP', Math.round(N * 0.1), ['WINDEFATP']],
    ['EMS', 500, ['AAD_PREMIUM', 'INTUNE_A']],
  ];
  const skuIds = skuDefs.map((_, i) => guid(2, i));
  const consumed = new Array<number>(skuDefs.length).fill(0);

  // licence groups (group-based licensing): one per main SKU
  const licenceGroupFor = (sku: number) => 1 + sku; // group indexes 1..3

  // --- users ---
  const users: GraphObject[] = new Array(N);
  const managerOf = new Int32Array(N).fill(-1);
  const deptOf = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const guest = unit(seed, i, 1) < 0.08 && i > 50;
    const first = FIRST[hash32(seed, i, 2) % FIRST.length]!;
    const last = LAST[hash32(seed, i, 3) % LAST.length]!;
    const long = hash32(seed, i, 4) % 997 === 0;
    const displayName = long
      ? `${first} ${last} (Contractor — Regional Programme Office, Infrastructure Modernisation Workstream ${i})`
      : `${first} ${last}`;
    const nick = `${ascii(first) || 'user'}.${ascii(last) || 'x'}${i}`;
    const upn = guest ? `${nick}_partner.example#EXT#@example.onmicrosoft.com` : `${nick}@example.com`;
    const dept = hash32(seed, i, 5) % DEPARTMENTS.length;
    deptOf[i] = dept;
    const countryPick = unit(seed, i, 6) * 100;
    let acc = 0;
    let country: string | null = null;
    for (const [c, w] of COUNTRIES) {
      acc += w;
      if (countryPick < acc) {
        country = c;
        break;
      }
    }
    const enabled = guest ? unit(seed, i, 7) > 0.04 : unit(seed, i, 7) > 0.06;
    const created = NOW_MS - Math.floor(unit(seed, i, 8) * 8 * 365 * DAY);
    // last sign-in: 70% ≤30d, 15% 30–90d, 7% 90–365d, 3% older, 5% never (guests twice as idle)
    const r = unit(seed, i, 9) * (guest ? 0.6 : 1);
    const lastMs =
      r < 0.05
        ? null
        : r < 0.08
          ? NOW_MS - (365 + unit(seed, i, 10) * 900) * DAY
          : r < 0.15
            ? NOW_MS - (90 + unit(seed, i, 10) * 275) * DAY
            : r < 0.3
              ? NOW_MS - (30 + unit(seed, i, 10) * 60) * DAY
              : NOW_MS - unit(seed, i, 10) * 30 * DAY;
    const synced = !guest && unit(seed, i, 11) < 0.55;
    const assignedLicenses: GraphObject[] = [];
    const licenseAssignmentStates: GraphObject[] = [];
    if (!guest && unit(seed, i, 12) > 0.07) {
      const lr = unit(seed, i, 13);
      const main = lr < 0.42 ? 0 : lr < 0.92 ? 1 : 2;
      const viaGroup = unit(seed, i, 14) < 0.6;
      const errorRoll = unit(seed, i, 15);
      const error =
        viaGroup && errorRoll < 0.005
          ? errorRoll < 0.0025
            ? 'CountViolation'
            : 'MutuallyExclusiveViolation'
          : 'None';
      if (error === 'None') {
        assignedLicenses.push({ skuId: skuIds[main], disabledPlans: [] });
        consumed[main]!++;
      }
      licenseAssignmentStates.push({
        skuId: skuIds[main],
        assignedByGroup: viaGroup ? guid(10, licenceGroupFor(main)) : null,
        state: error === 'None' ? 'Active' : 'Error',
        error,
        disabledPlans: [],
        lastUpdatedDateTime: iso(created + DAY),
      });
      // duplicate direct + group assignment on a few
      if (viaGroup && unit(seed, i, 16) < 0.01) {
        licenseAssignmentStates.push({
          skuId: skuIds[main],
          assignedByGroup: null,
          state: 'Active',
          error: 'None',
          disabledPlans: [],
        });
      }
      if (unit(seed, i, 17) < 0.2) {
        assignedLicenses.push({ skuId: skuIds[3], disabledPlans: [] });
        consumed[3]!++;
        licenseAssignmentStates.push({
          skuId: skuIds[3],
          assignedByGroup: null,
          state: 'Active',
          error: 'None',
          disabledPlans: [],
        });
      }
    }
    const id = guid(3, i);
    users[i] = {
      id,
      displayName,
      givenName: first,
      surname: last,
      userPrincipalName: upn,
      mail: guest ? `${nick}@partner.example` : upn,
      mailNickname: nick,
      otherMails: [],
      proxyAddresses: guest ? [] : [`SMTP:${upn}`],
      accountEnabled: enabled,
      userType: guest ? 'Guest' : 'Member',
      creationType: guest ? 'Invitation' : null,
      externalUserState: guest ? (unit(seed, i, 18) < 0.15 ? 'PendingAcceptance' : 'Accepted') : null,
      externalUserStateChangeDateTime: guest ? iso(created + DAY) : null,
      createdDateTime: iso(created),
      department: unit(seed, i, 19) < 0.04 ? null : DEPARTMENTS[dept],
      jobTitle:
        unit(seed, i, 20) < 0.06
          ? null
          : ['Engineer', 'Analyst', 'Manager', 'Director', 'Specialist', 'Consultant', 'Intern'][
              hash32(seed, i, 21) % 7
            ],
      companyName: guest ? 'Partner Example Ltd' : 'Example Org',
      officeLocation: country ? `${country}-${(hash32(seed, i, 22) % 40) + 1}` : null,
      city: country ? CITIES[country]![hash32(seed, i, 23) % CITIES[country]!.length] : null,
      country,
      usageLocation: guest ? null : country,
      employeeId: guest || unit(seed, i, 24) < 0.05 ? null : String(100000 + i),
      employeeType: guest ? null : unit(seed, i, 25) < 0.1 ? 'Contractor' : 'Employee',
      employeeHireDate: guest ? null : iso(created),
      businessPhones: unit(seed, i, 26) < 0.5 ? [`+1 555 01${String(i % 100).padStart(2, '0')}`] : [],
      mobilePhone: null,
      preferredLanguage: ['en-US', 'en-GB', 'de-DE', 'ja-JP', 'fr-FR'][hash32(seed, i, 27) % 5],
      onPremisesSyncEnabled: synced ? true : null,
      onPremisesLastSyncDateTime: synced ? iso(NOW_MS - 30 * 60_000) : null,
      onPremisesSamAccountName: synced ? nick.slice(0, 20) : null,
      onPremisesImmutableId: synced ? Buffer.from(id).toString('base64').slice(0, 24) : null,
      onPremisesDistinguishedName: synced ? `CN=${nick},OU=Users,DC=corp,DC=example,DC=com` : null,
      passwordPolicies: unit(seed, i, 28) < 0.03 ? 'DisablePasswordExpiration' : 'None',
      lastPasswordChangeDateTime: iso(created + Math.floor(unit(seed, i, 29) * (NOW_MS - created))),
      signInSessionsValidFromDateTime: iso(created),
      assignedLicenses,
      licenseAssignmentStates,
      signInActivity: {
        lastSignInDateTime: lastMs === null ? null : iso(lastMs),
        lastSignInRequestId: lastMs === null ? null : guid(4, i),
        lastNonInteractiveSignInDateTime: lastMs === null ? null : iso(Math.min(NOW_MS, lastMs + 3_600_000)),
        lastSuccessfulSignInDateTime: lastMs === null ? null : iso(lastMs),
      },
      identities: [
        { signInType: 'userPrincipalName', issuer: 'example.onmicrosoft.com', issuerAssignedId: upn },
      ],
      ageGroup: null,
      deletedDateTime: null,
    };
    ids.add(id, 'user', () => users[i]!);
  }
  // managers: within the department, someone earlier in the list; the first ~1% have none
  for (let i = Math.max(1, Math.floor(N * 0.01)); i < N; i++) {
    if (users[i]!.userType === 'Guest') continue;
    const candidate = hash32(seed, i, 30) % i;
    managerOf[i] = candidate;
  }

  // --- groups ---
  const G = scale.groups;
  const groups: GraphObject[] = new Array(G);
  const gStart = new Int32Array(G);
  const gStride = new Int32Array(G);
  const gCount = new Int32Array(G);
  const gInv = new Int32Array(G);
  const nestedGroups = new Map<number, number[]>();
  const groupOwners: number[][] = new Array(G);
  const teams: number[] = [];
  const strideFor = (g: number) => {
    let s = (hash32(seed, g, 40) % (N - 1)) + 1;
    while (gcd(s, N) !== 1) s = (s % (N - 1)) + 1;
    return s;
  };
  for (let g = 0; g < G; g++) {
    const r = unit(seed, g, 41);
    const special = g === 0 ? 'all' : g <= 3 ? 'licence' : '';
    const unified = special === '' && r < 0.3;
    const dynamic = special === 'all' || (special === '' && r >= 0.3 && r < 0.37);
    const mailEnabledSec = special === '' && r >= 0.37 && r < 0.4;
    const synced = special === '' && !unified && unit(seed, g, 42) < 0.2;
    const sizeRoll = unit(seed, g, 43);
    const count =
      special === 'all'
        ? N
        : special === 'licence'
          ? Math.round(N * [0.25, 0.3, 0.06][g - 1]!)
          : sizeRoll < 0.08
            ? 0
            : sizeRoll < 0.9
              ? 1 + (hash32(seed, g, 44) % 60)
              : sizeRoll < 0.998
                ? 60 + (hash32(seed, g, 44) % 1940)
                : 2000 + (hash32(seed, g, 44) % Math.max(1, Math.min(30_000, N - 2000)));
    gStart[g] = special === 'all' ? 0 : hash32(seed, g, 45) % N;
    gStride[g] = special === 'all' ? 1 : strideFor(g);
    gCount[g] = Math.min(count, N);
    gInv[g] = modInverse(gStride[g]!, N);
    const ownerless = special === '' && unit(seed, g, 46) < (unified ? 0.05 : 0.12);
    groupOwners[g] = ownerless
      ? []
      : Array.from({ length: 1 + (hash32(seed, g, 47) % 3) }, (_, k) => hash32(seed, g, 48, k) % N);
    if (special === '' && !unified && !dynamic && unit(seed, g, 49) < 0.1)
      nestedGroups.set(
        g,
        Array.from(
          { length: 1 + (hash32(seed, g, 50) % 5) },
          (_, k) => 4 + (hash32(seed, g, 51, k) % (G - 4)),
        ),
      );
    const team = unified && unit(seed, g, 52) < 0.33;
    if (team) teams.push(g);
    const word = [
      'Project',
      'Team',
      'Ops',
      'Finance',
      'Site',
      'App',
      'Region',
      'Programme',
      'Squad',
      "Partners'",
    ][hash32(seed, g, 53) % 10];
    const name =
      special === 'all'
        ? 'All Company'
        : special === 'licence'
          ? `LIC-${skuDefs[g - 1]![0]}`
          : `${unified ? 'M365' : 'SG'}-${word}-${DEPARTMENTS[hash32(seed, g, 54) % DEPARTMENTS.length]}-${g}`;
    const created = NOW_MS - Math.floor(unit(seed, g, 55) * 7 * 365 * DAY);
    const id = guid(10, g);
    groups[g] = {
      id,
      displayName: name,
      description:
        unit(seed, g, 56) < 0.3
          ? null
          : `Synthetic group ${g} for ${DEPARTMENTS[hash32(seed, g, 54) % DEPARTMENTS.length]}`,
      mail: unified || mailEnabledSec ? `${ascii(name).slice(0, 40)}${g}@example.com` : null,
      mailEnabled: unified || mailEnabledSec,
      mailNickname: `${ascii(name).slice(0, 40)}${g}`,
      securityEnabled: !unified || unit(seed, g, 57) < 0.1,
      groupTypes: [...(unified ? ['Unified'] : []), ...(dynamic ? ['DynamicMembership'] : [])],
      membershipRule: dynamic
        ? special === 'all'
          ? '(user.accountEnabled -eq true)'
          : `(user.department -eq "${DEPARTMENTS[g % DEPARTMENTS.length]}")`
        : null,
      membershipRuleProcessingState: dynamic ? (unit(seed, g, 58) < 0.05 ? 'Paused' : 'On') : null,
      visibility: unified ? (unit(seed, g, 59) < 0.4 ? 'Public' : 'Private') : null,
      createdDateTime: iso(created),
      renewedDateTime: iso(created),
      expirationDateTime:
        unified && unit(seed, g, 60) < 0.2 ? iso(NOW_MS + Math.floor(unit(seed, g, 61) * 60) * DAY) : null,
      isAssignableToRole: special === '' && unit(seed, g, 62) < 0.002,
      onPremisesSyncEnabled: synced ? true : null,
      onPremisesLastSyncDateTime: synced ? iso(NOW_MS - 30 * 60_000) : null,
      resourceProvisioningOptions: team ? ['Team'] : [],
      assignedLicenses: special === 'licence' ? [{ skuId: skuIds[g - 1], disabledPlans: [] }] : [],
      classification: null,
      deletedDateTime: null,
    };
    ids.add(id, 'group', () => groups[g]!);
  }
  const groupHasUser = (g: number, u: number) => {
    const c = gCount[g]!;
    if (c === 0) return false;
    if (c >= N) return true;
    const k = (((u - gStart[g]!) % N) + N) % N;
    // k, inv < N ≤ 100k: the product stays well inside 2^53.
    const pos = (k * gInv[g]!) % N;
    return pos < c;
  };
  const userGroups = (u: number) => {
    const out: number[] = [];
    for (let g = 0; g < G; g++) if (groupHasUser(g, u)) out.push(g);
    return out;
  };

  // --- devices ---
  const MD = scale.managedDevices;
  const managedDevices: GraphObject[] = new Array(MD);
  const deviceOwner = new Int32Array(MD);
  const osPick = (r: number) => (r < 0.7 ? 'Windows' : r < 0.85 ? 'iOS' : r < 0.95 ? 'Android' : 'macOS');
  const osVersion = (os: string, r: number) =>
    os === 'Windows'
      ? ['10.0.19045.4529', '10.0.22631.4317', '10.0.26100.2033', '10.0.19044.3086', '10.0.22621.3880'][
          Math.floor(r * 5)
        ]!
      : os === 'iOS'
        ? ['17.6.1', '18.0.1', '16.7.10'][Math.floor(r * 3)]!
        : os === 'Android'
          ? ['14', '13', '12'][Math.floor(r * 3)]!
          : ['14.7', '15.0.1'][Math.floor(r * 2)]!;
  for (let d = 0; d < MD; d++) {
    const owner = hash32(seed, d, 70) % N;
    deviceOwner[d] = owner;
    const os = osPick(unit(seed, d, 71));
    const lastSync =
      NOW_MS - (unit(seed, d, 72) < 0.08 ? 30 + unit(seed, d, 73) * 200 : unit(seed, d, 73) * 7) * DAY;
    const cr = unit(seed, d, 74);
    const id = guid(20, d);
    managedDevices[d] = {
      id,
      deviceName: `EX-${os === 'Windows' ? 'LT' : os === 'macOS' ? 'MB' : 'MO'}-${String(d).padStart(6, '0')}`,
      managedDeviceName: `${ascii(String(users[owner]!.displayName)) || 'user'}_${os}_${d}`,
      operatingSystem: os,
      osVersion: osVersion(os, unit(seed, d, 75)),
      complianceState:
        cr < 0.85 ? 'compliant' : cr < 0.95 ? 'noncompliant' : cr < 0.98 ? 'inGracePeriod' : 'unknown',
      isEncrypted: unit(seed, d, 76) > 0.06,
      jailBroken:
        os === 'iOS' || os === 'Android' ? (unit(seed, d, 77) < 0.005 ? 'True' : 'False') : 'Unknown',
      lastSyncDateTime: iso(lastSync),
      enrolledDateTime: iso(lastSync - unit(seed, d, 78) * 900 * DAY),
      managementAgent: 'mdm',
      managedDeviceOwnerType: unit(seed, d, 79) < 0.85 ? 'company' : 'personal',
      deviceEnrollmentType:
        os === 'Windows'
          ? unit(seed, d, 80) < 0.6
            ? 'windowsAzureADJoin'
            : 'windowsAutoEnrollment'
          : 'userEnrollment',
      userId: users[owner]!.id,
      userPrincipalName: users[owner]!.userPrincipalName,
      userDisplayName: users[owner]!.displayName,
      emailAddress: users[owner]!.mail,
      azureADDeviceId: guid(21, d),
      azureADRegistered: true,
      serialNumber: `SN${hash32(seed, d, 81).toString(36).toUpperCase()}`,
      manufacturer:
        os === 'Windows'
          ? ['Contoso Devices', 'Fabrikam', 'Northwind'][d % 3]
          : os === 'iOS' || os === 'macOS'
            ? 'Apple'
            : 'Example Phones',
      model: os === 'Windows' ? `Laptop ${(d % 9) + 1}` : `${os} Model ${(d % 5) + 1}`,
      totalStorageSpaceInBytes: 256_000_000_000,
      freeStorageSpaceInBytes: Math.floor(unit(seed, d, 82) * 200_000_000_000),
      autopilotEnrolled: os === 'Windows' && unit(seed, d, 83) < 0.7,
      partnerReportedThreatState: 'unknown',
      deviceRegistrationState: 'registered',
      exchangeAccessState: 'allowed',
    };
    ids.add(id, 'managedDevice', () => managedDevices[d]!);
  }
  const ED = scale.entraDevices;
  const entraDevices: GraphObject[] = new Array(ED);
  for (let d = 0; d < ED; d++) {
    const managed = d < MD ? managedDevices[d]! : undefined;
    const os = managed ? String(managed.operatingSystem) : osPick(unit(seed, d, 90));
    const last =
      NOW_MS - (unit(seed, d, 91) < 0.12 ? 90 + unit(seed, d, 92) * 400 : unit(seed, d, 92) * 30) * DAY;
    const trust = os === 'Windows' ? (unit(seed, d, 93) < 0.4 ? 'ServerAd' : 'AzureAd') : 'Workplace';
    const id = guid(22, d);
    entraDevices[d] = {
      id,
      deviceId: managed ? managed.azureADDeviceId : guid(21, d),
      displayName: managed ? managed.deviceName : `EX-BYOD-${String(d).padStart(6, '0')}`,
      operatingSystem: os,
      operatingSystemVersion: managed ? managed.osVersion : osVersion(os, unit(seed, d, 94)),
      trustType: trust,
      accountEnabled: unit(seed, d, 95) > 0.03,
      isCompliant: managed ? managed.complianceState === 'compliant' : null,
      isManaged: Boolean(managed),
      approximateLastSignInDateTime: iso(last),
      registrationDateTime: iso(last - unit(seed, d, 96) * 800 * DAY),
      createdDateTime: iso(last - unit(seed, d, 96) * 800 * DAY),
      profileType: trust === 'Workplace' ? 'RegisteredDevice' : null,
      onPremisesSyncEnabled: trust === 'ServerAd' ? true : null,
      physicalIds: [],
      extensionAttributes: {},
    };
    ids.add(id, 'device', () => entraDevices[d]!);
  }

  // --- applications and service principals ---
  const A = scale.apps;
  const applications: GraphObject[] = new Array(A);
  const servicePrincipals: GraphObject[] = [];
  const appOwners: number[][] = new Array(A);
  const graphAppRoles = GRAPH_ROLES.map((value, k) => ({
    id: guid(30, k),
    value,
    displayName: value,
    allowedMemberTypes: ['Application'],
    isEnabled: true,
  }));
  const graphScopes = GRAPH_ROLES.map((value, k) => ({
    id: guid(31, k),
    value,
    type: 'Admin',
    isEnabled: true,
  }));
  for (const [appId, displayName, roles] of [
    [GRAPH_APP_ID, 'Microsoft Graph', graphAppRoles],
    [
      EXCHANGE_APP_ID,
      'Office 365 Exchange Online',
      [
        {
          id: guid(32, 0),
          value: 'Exchange.ManageAsApp',
          displayName: 'Exchange.ManageAsApp',
          allowedMemberTypes: ['Application'],
          isEnabled: true,
        },
      ],
    ],
    [
      SHAREPOINT_APP_ID,
      'Office 365 SharePoint Online',
      [
        {
          id: guid(33, 0),
          value: 'Sites.FullControl.All',
          displayName: 'Sites.FullControl.All',
          allowedMemberTypes: ['Application'],
          isEnabled: true,
        },
      ],
    ],
  ] as const) {
    const id = guid(34, servicePrincipals.length);
    const sp = {
      id,
      appId,
      displayName,
      servicePrincipalType: 'Application',
      accountEnabled: true,
      appOwnerOrganizationId: 'f8cdef31-a31e-4b4a-93e4-5f571e91255a',
      appRoles: roles,
      oauth2PermissionScopes: appId === GRAPH_APP_ID ? graphScopes : [],
      tags: [],
      passwordCredentials: [],
      keyCredentials: [],
      preferredSingleSignOnMode: null,
      appRoleAssignmentRequired: false,
    };
    servicePrincipals.push(sp);
    ids.add(id, 'servicePrincipal', () => sp);
  }
  const firstPartyCount = servicePrincipals.length;
  const credentials = (i: number, salt: number) =>
    Array.from({ length: hash32(seed, i, salt) % 4 }, (_, k) => {
      const er = unit(seed, i, salt + 1, k);
      const end =
        er < 0.06
          ? NOW_MS - er * 100 * DAY
          : er < 0.12
            ? NOW_MS + er * 250 * DAY
            : NOW_MS + (60 + er * 700) * DAY;
      const start = end - (er < 0.5 ? 730 : 365) * DAY;
      return {
        keyId: guid(35, i * 8 + k + salt * 100_000),
        displayName: k === 0 ? 'prod secret' : `secret ${k}`,
        startDateTime: iso(start),
        endDateTime: iso(end),
        hint: 'ab~',
      };
    });
  for (let a = 0; a < A; a++) {
    const appId = guid(36, a);
    const created = NOW_MS - Math.floor(unit(seed, a, 100) * 6 * 365 * DAY);
    const risky = unit(seed, a, 101) < 0.03;
    const req = Array.from(
      { length: hash32(seed, a, 102) % 5 },
      (_, k) => graphAppRoles[hash32(seed, a, 103, k) % graphAppRoles.length]!,
    );
    const id = guid(37, a);
    applications[a] = {
      id,
      appId,
      displayName: `${['Payroll', 'CRM', 'Portal', 'Sync', 'Bot', 'Reporting', 'Intranet', "Partners' API"][a % 8]} App ${a}`,
      createdDateTime: iso(created),
      signInAudience: risky ? 'AzureADandPersonalMicrosoftAccount' : 'AzureADMyOrg',
      publisherDomain: 'example.com',
      passwordCredentials: credentials(a, 104),
      keyCredentials:
        unit(seed, a, 106) < 0.15
          ? credentials(a, 107).map((c) => ({ ...c, type: 'AsymmetricX509Cert', usage: 'Verify' }))
          : [],
      requiredResourceAccess: req.length
        ? [{ resourceAppId: GRAPH_APP_ID, resourceAccess: req.map((r) => ({ id: r.id, type: 'Role' })) }]
        : [],
      web: {
        redirectUris: risky
          ? ['http://localhost:8080/callback', 'https://*.example.com/signin']
          : [`https://app${a}.example.com/signin-oidc`],
        implicitGrantSettings: { enableIdTokenIssuance: risky, enableAccessTokenIssuance: risky },
      },
      spa: { redirectUris: [] },
      publicClient: { redirectUris: risky ? ['ms-app://x'] : [] },
      isFallbackPublicClient: risky,
      tags: [],
      deletedDateTime: null,
    };
    appOwners[a] = unit(seed, a, 108) < 0.3 ? [] : [hash32(seed, a, 109) % N];
    ids.add(id, 'application', () => applications[a]!);
    const spId = guid(38, a);
    const saml = unit(seed, a, 110) < 0.03;
    const sp: GraphObject = {
      id: spId,
      appId,
      displayName: applications[a]!.displayName,
      servicePrincipalType: unit(seed, a, 111) < 0.1 ? 'ManagedIdentity' : 'Application',
      accountEnabled: unit(seed, a, 112) > 0.02,
      appOwnerOrganizationId: tenantId,
      appRoleAssignmentRequired: unit(seed, a, 113) < 0.3,
      preferredSingleSignOnMode: saml ? 'saml' : null,
      preferredTokenSigningKeyThumbprint: saml
        ? hash32(seed, a, 114).toString(16).toUpperCase().padStart(40, '0')
        : null,
      keyCredentials: saml
        ? credentials(a, 115).map((c) => ({ ...c, type: 'AsymmetricX509Cert', usage: 'Sign' }))
        : [],
      passwordCredentials: unit(seed, a, 117) < 0.02 ? credentials(a, 118) : [],
      tags: saml
        ? ['WindowsAzureActiveDirectoryCustomSingleSignOnApplication']
        : ['WindowsAzureActiveDirectoryIntegratedApp'],
      appRoles: [],
      oauth2PermissionScopes: [],
      createdDateTime: iso(created),
      notificationEmailAddresses: [],
    };
    servicePrincipals.push(sp);
    ids.add(spId, 'servicePrincipal', () => sp);
  }

  // --- licences totals ---
  const subscribedSkus = skuDefs.map(([part, units, plans], k) => ({
    id: `${tenantId}_${skuIds[k]}`,
    skuId: skuIds[k],
    skuPartNumber: part,
    appliesTo: 'User',
    capabilityStatus: k === 6 ? 'Warning' : 'Enabled',
    consumedUnits: Math.min(consumed[k]! || Math.round(units * 0.7), units + 50),
    prepaidUnits: { enabled: units, suspended: 0, warning: k === 6 ? units : 0, lockedOut: 0 },
    servicePlans: plans.map((p, j) => ({
      servicePlanId: guid(39, k * 20 + j),
      servicePlanName: p,
      provisioningStatus: 'Success',
      appliesTo: 'User',
    })),
  }));

  // --- roles ---
  const roleDefinitions = ROLE_TEMPLATES.map(([templateId, displayName, privileged]) => ({
    id: templateId,
    templateId,
    displayName,
    description: `${displayName} (synthetic)`,
    isBuiltIn: true,
    isEnabled: true,
    isPrivileged: privileged,
    rolePermissions: [{ allowedResourceActions: ['microsoft.directory/users/standard/read'] }],
  }));
  const principalFor = (k: number) => {
    const r = unit(seed, k, 120);
    return r < 0.8
      ? users[hash32(seed, k, 121) % N]!.id
      : r < 0.9
        ? groups[4 + (hash32(seed, k, 122) % (G - 4))]!.id
        : servicePrincipals[firstPartyCount + (hash32(seed, k, 123) % A)]!.id;
  };
  const roleAssignments: GraphObject[] = [];
  const assignmentCount = Math.max(60, Math.round(N * 0.03));
  for (let k = 0; k < assignmentCount; k++) {
    const role = k < 8 ? 0 : 1 + (hash32(seed, k, 124) % (ROLE_TEMPLATES.length - 1));
    roleAssignments.push({
      id: guid(40, k),
      roleDefinitionId: ROLE_TEMPLATES[role]![0],
      principalId: principalFor(k),
      directoryScopeId: unit(seed, k, 125) < 0.05 ? `/administrativeUnits/${guid(41, k % 20)}` : '/',
      createdDateTime: iso(NOW_MS - unit(seed, k, 126) * 900 * DAY),
    });
  }
  const roleEligibilities: GraphObject[] = [];
  for (let k = 0; k < Math.round(assignmentCount / 2); k++) {
    const role = hash32(seed, k, 127) % ROLE_TEMPLATES.length;
    roleEligibilities.push({
      id: guid(42, k),
      roleDefinitionId: ROLE_TEMPLATES[role]![0],
      principalId: principalFor(k + 100_000),
      directoryScopeId: '/',
      memberType: 'Direct',
      startDateTime: iso(NOW_MS - 100 * DAY),
      endDateTime: unit(seed, k, 128) < 0.5 ? null : iso(NOW_MS + 200 * DAY),
    });
  }

  // --- logs (lazy) ---
  const signInInterval = DAY / scale.signInsPerDay;
  const APPS = [
    'Office 365 Exchange Online',
    'Microsoft Teams',
    'Office 365 SharePoint Online',
    'Azure Portal',
    'Microsoft Authentication Broker',
    'Payroll App 0',
    'Windows Sign In',
    'Microsoft Edge',
    'OfficeHome',
  ];
  const FAIL: Array<[number, string]> = [
    [0, ''],
    [50126, 'Invalid username or password.'],
    [50074, 'Strong authentication is required.'],
    [53003, 'Access has been blocked by Conditional Access policies.'],
    [50053, 'Account is locked.'],
    [500121, 'Authentication failed during strong authentication request.'],
  ];
  const signIns: Collection = {
    size: LOG_DAYS * scale.signInsPerDay,
    scanBudget: 250_000,
    at: (i) => {
      const u = hash32(seed, i, 130) % N;
      const user = users[u]!;
      const fr = unit(seed, i, 131);
      const [errorCode, failureReason] =
        fr < 0.88 ? FAIL[0]! : FAIL[1 + (hash32(seed, i, 132) % (FAIL.length - 1))]!;
      const country = (user.country as string | null) ?? 'US';
      const foreign = unit(seed, i, 133) < 0.01;
      const app = APPS[hash32(seed, i, 134) % APPS.length]!;
      return {
        id: guid(50, i),
        createdDateTime: iso(NOW_MS - i * signInInterval),
        userId: user.id,
        userDisplayName: user.displayName,
        userPrincipalName: user.userPrincipalName,
        appId: guid(51, hash32(seed, i, 134) % APPS.length),
        appDisplayName: app,
        resourceDisplayName: app,
        ipAddress: `198.51.100.${hash32(seed, u, 135) % 250}`,
        clientAppUsed: unit(seed, i, 136) < 0.01 ? 'Exchange ActiveSync' : 'Browser',
        isInteractive: unit(seed, i, 137) < 0.4,
        correlationId: guid(52, i),
        conditionalAccessStatus:
          errorCode === 53003 ? 'failure' : unit(seed, i, 138) < 0.7 ? 'success' : 'notApplied',
        appliedConditionalAccessPolicies: [
          {
            id: guid(60, 0),
            displayName: 'AF-Audit: Require MFA for all users',
            enforcedGrantControls: ['Mfa'],
            result: unit(seed, i, 139) < 0.1 ? 'reportOnlyFailure' : 'reportOnlySuccess',
          },
        ],
        authenticationRequirement:
          unit(seed, i, 140) < 0.6 ? 'multiFactorAuthentication' : 'singleFactorAuthentication',
        riskLevelDuringSignIn: unit(seed, i, 141) < 0.003 ? 'high' : 'none',
        riskState: 'none',
        riskDetail: 'none',
        status: { errorCode, failureReason: failureReason || null, additionalDetails: null },
        location: {
          city: foreign ? 'Unknown' : ((user.city as string | null) ?? 'Seattle'),
          state: null,
          countryOrRegion: foreign ? 'NL' : country,
          geoCoordinates: null,
        },
        deviceDetail: {
          deviceId: '',
          displayName: null,
          operatingSystem: ['Windows10', 'iOS', 'Android', 'MacOs'][hash32(seed, i, 142) % 4],
          browser: 'Edge 130.0',
          isCompliant: null,
          isManaged: null,
          trustType: null,
        },
      };
    },
    range: (field, from, to) => {
      if (field !== 'createdDateTime') return undefined;
      const size = LOG_DAYS * scale.signInsPerDay;
      // index i ↔ time NOW - i·interval (newest first)
      const lo = to === undefined ? 0 : Math.max(0, Math.ceil((NOW_MS - to) / signInInterval));
      const hi = from === undefined ? size : Math.min(size, Math.floor((NOW_MS - from) / signInInterval) + 1);
      return [lo, Math.max(lo, hi)];
    },
  };
  const auditInterval = DAY / scale.auditsPerDay;
  const ACTIVITIES: Array<[string, string, string]> = [
    ['Update user', 'UserManagement', 'User'],
    ['Add member to group', 'GroupManagement', 'Group'],
    ['Remove member from group', 'GroupManagement', 'Group'],
    ['Add member to role', 'RoleManagement', 'User'],
    ['Consent to application', 'ApplicationManagement', 'ServicePrincipal'],
    ['Update application – Certificates and secrets management ', 'ApplicationManagement', 'Application'],
    ['Update conditional access policy', 'Policy', 'Policy'],
    ['Reset password (by admin)', 'UserManagement', 'User'],
    ['Add user', 'UserManagement', 'User'],
    ['Delete user', 'UserManagement', 'User'],
    ['Add eligible member to role in PIM completed (permanent)', 'RoleManagement', 'User'],
    ['Update named location', 'Policy', 'Policy'],
  ];
  const directoryAudits: Collection = {
    size: LOG_DAYS * scale.auditsPerDay,
    scanBudget: 250_000,
    at: (i) => {
      const [activity, category, type] = ACTIVITIES[hash32(seed, i, 150) % ACTIVITIES.length]!;
      const actor = users[hash32(seed, i, 151) % N]!;
      const target =
        type === 'Group'
          ? groups[hash32(seed, i, 152) % G]!
          : type === 'Application'
            ? applications[hash32(seed, i, 152) % A]!
            : type === 'ServicePrincipal'
              ? servicePrincipals[hash32(seed, i, 152) % servicePrincipals.length]!
              : users[hash32(seed, i, 152) % N]!;
      return {
        id: `Directory_${guid(53, i)}`,
        category,
        correlationId: guid(54, i),
        result: unit(seed, i, 153) < 0.97 ? 'success' : 'failure',
        resultReason: '',
        activityDisplayName: activity,
        activityDateTime: iso(NOW_MS - i * auditInterval),
        loggedByService: category === 'RoleManagement' && activity.includes('PIM') ? 'PIM' : 'Core Directory',
        operationType: activity.startsWith('Add')
          ? 'Add'
          : activity.startsWith('Delete')
            ? 'Delete'
            : 'Update',
        initiatedBy:
          unit(seed, i, 154) < 0.8
            ? {
                user: {
                  id: actor.id,
                  displayName: null,
                  userPrincipalName: actor.userPrincipalName,
                  ipAddress: '198.51.100.7',
                },
                app: null,
              }
            : {
                user: null,
                app: { appId: guid(36, 1), displayName: 'Sync App 1', servicePrincipalId: guid(38, 1) },
              },
        targetResources: [
          {
            id: target.id,
            displayName: target.displayName ?? null,
            type,
            userPrincipalName: type === 'User' ? target.userPrincipalName : null,
            modifiedProperties:
              type === 'Group'
                ? [
                    {
                      displayName: 'Group.DisplayName',
                      oldValue: null,
                      newValue: JSON.stringify(target.displayName),
                    },
                  ]
                : [],
          },
        ],
        additionalDetails: [],
      };
    },
    range: (field, from, to) => {
      if (field !== 'activityDateTime') return undefined;
      const size = LOG_DAYS * scale.auditsPerDay;
      const lo = to === undefined ? 0 : Math.max(0, Math.ceil((NOW_MS - to) / auditInterval));
      const hi = from === undefined ? size : Math.min(size, Math.floor((NOW_MS - from) / auditInterval) + 1);
      return [lo, Math.max(lo, hi)];
    },
  };

  // --- identity protection ---
  const riskyCount = Math.max(20, Math.round(N * 0.015));
  const riskyUsers: GraphObject[] = Array.from({ length: riskyCount }, (_, k) => {
    const u = users[hash32(seed, k, 160) % N]!;
    const r = unit(seed, k, 161);
    return {
      id: u.id,
      userDisplayName: u.displayName,
      userPrincipalName: u.userPrincipalName,
      riskLevel: r < 0.2 ? 'high' : r < 0.5 ? 'medium' : 'low',
      riskState: r < 0.7 ? 'atRisk' : r < 0.8 ? 'confirmedCompromised' : r < 0.9 ? 'remediated' : 'dismissed',
      riskDetail: 'none',
      riskLastUpdatedDateTime: iso(NOW_MS - unit(seed, k, 162) * 60 * DAY),
      isDeleted: false,
      isProcessing: false,
    };
  });
  const riskDetections: Collection = {
    size: riskyCount * 12,
    at: (i) => {
      const u = riskyUsers[i % riskyCount]!;
      return {
        id: guid(55, i),
        userId: u.id,
        userDisplayName: u.userDisplayName,
        userPrincipalName: u.userPrincipalName,
        riskEventType: [
          'unfamiliarFeatures',
          'passwordSpray',
          'anonymizedIPAddress',
          'leakedCredentials',
          'impossibleTravel',
        ][i % 5],
        riskLevel: u.riskLevel,
        riskState: 'atRisk',
        detectedDateTime: iso(NOW_MS - (i / (riskyCount * 12)) * 90 * DAY),
        activityDateTime: iso(NOW_MS - (i / (riskyCount * 12)) * 90 * DAY),
        ipAddress: '203.0.113.9',
        location: { city: 'Amsterdam', countryOrRegion: 'NL' },
        detectionTimingType: 'realtime',
        source: 'IdentityProtection',
      };
    },
  };
  const memberIdx: number[] = [];
  for (let i = 0; i < N; i++) if (users[i]!.userType === 'Member') memberIdx.push(i);
  const userRegistrationDetails = virtual(memberIdx.length, (k) => {
    const i = memberIdx[k]!;
    const u = users[i]!;
    const r = unit(seed, i, 170);
    const methods =
      r < 0.08
        ? []
        : r < 0.2
          ? ['mobilePhone']
          : r < 0.25
            ? ['email']
            : r < 0.7
              ? ['microsoftAuthenticatorPush', 'softwareOneTimePasscode']
              : ['microsoftAuthenticatorPush', 'windowsHelloForBusiness', 'passKeyDeviceBound'];
    return {
      id: u.id,
      userPrincipalName: u.userPrincipalName,
      userDisplayName: u.displayName,
      userType: 'member',
      isAdmin: i < 40,
      isMfaCapable: methods.length > 0 && !(methods.length === 1 && methods[0] === 'email'),
      isMfaRegistered: methods.length > 0,
      isPasswordlessCapable: methods.includes('windowsHelloForBusiness'),
      isSsprRegistered: methods.length > 0,
      isSsprEnabled: true,
      isSsprCapable: methods.length > 0,
      isSystemPreferredAuthenticationMethodEnabled: true,
      methodsRegistered: methods,
      defaultMfaMethod: methods.length
        ? methods[0] === 'mobilePhone'
          ? 'mobilePhone'
          : 'microsoftAuthenticatorPush'
        : 'none',
      lastUpdatedDateTime: iso(NOW_MS - DAY),
    };
  });
  const graphSpId = servicePrincipals[0]!.id as string;
  const oauth2PermissionGrants = virtual(Math.max(50, Math.round(N * 0.5)), (k) => {
    const all = unit(seed, k, 180) < 0.2;
    const client = servicePrincipals[firstPartyCount + (hash32(seed, k, 181) % A)]!;
    return {
      id: `grant-${guid(56, k)}`,
      clientId: client.id,
      consentType: all ? 'AllPrincipals' : 'Principal',
      principalId: all ? null : users[hash32(seed, k, 182) % N]!.id,
      resourceId: graphSpId,
      scope: ` ${['User.Read', 'Mail.Read offline_access', 'Files.ReadWrite.All', 'Directory.AccessAsUser.All', 'Mail.ReadWrite Mail.Send'][hash32(seed, k, 183) % 5]}`,
    };
  });
  const graphAppRoleAssignedTo = virtual(Math.max(30, Math.round(A * 1.5)), (k) => {
    const sp = servicePrincipals[firstPartyCount + (hash32(seed, k, 190) % A)]!;
    const role = graphAppRoles[hash32(seed, k, 191) % graphAppRoles.length]!;
    return {
      id: `ara-${guid(57, k)}`,
      appRoleId: role.id,
      principalId: sp.id,
      principalDisplayName: sp.displayName,
      principalType: 'ServicePrincipal',
      resourceId: graphSpId,
      resourceDisplayName: 'Microsoft Graph',
      createdDateTime: iso(NOW_MS - unit(seed, k, 192) * 700 * DAY),
    };
  });

  // --- Intune ---
  const assignmentsFor = (k: number) =>
    hash32(seed, k, 200) % 7 === 0
      ? []
      : [
          {
            id: guid(61, k),
            target: {
              '@odata.type': '#microsoft.graph.groupAssignmentTarget',
              groupId: groups[4 + (k % (G - 4))]!.id,
            },
          },
        ];
  const compliancePolicies = Array.from({ length: 60 }, (_, k) => ({
    '@odata.type': [
      '#microsoft.graph.windows10CompliancePolicy',
      '#microsoft.graph.iosCompliancePolicy',
      '#microsoft.graph.androidWorkProfileCompliancePolicy',
      '#microsoft.graph.macOSCompliancePolicy',
    ][k % 4],
    id: guid(62, k),
    displayName: `Compliance ${['Windows', 'iOS', 'Android', 'macOS'][k % 4]} ${k}`,
    description: null,
    createdDateTime: iso(NOW_MS - k * 20 * DAY),
    lastModifiedDateTime: iso(NOW_MS - k * 3 * DAY),
    version: 1 + (k % 9),
    assignments: assignmentsFor(k),
    scheduledActionsForRule: [],
  }));
  const deviceConfigurations = Array.from({ length: 250 }, (_, k) => ({
    '@odata.type': [
      '#microsoft.graph.windows10GeneralConfiguration',
      '#microsoft.graph.iosGeneralDeviceConfiguration',
      '#microsoft.graph.windowsUpdateForBusinessConfiguration',
    ][k % 3],
    id: guid(63, k),
    displayName: `Configuration ${k}`,
    description: null,
    createdDateTime: iso(NOW_MS - k * 5 * DAY),
    lastModifiedDateTime: iso(NOW_MS - k * DAY),
    version: 1,
    assignments: assignmentsFor(k + 1000),
  }));
  const configurationPolicies = Array.from({ length: 400 }, (_, k) => ({
    id: guid(64, k),
    name: `Settings catalog ${k}`,
    description: '',
    platforms: ['windows10', 'macOS', 'iOS'][k % 3],
    technologies: 'mdm',
    createdDateTime: iso(NOW_MS - k * 4 * DAY),
    lastModifiedDateTime: iso(NOW_MS - k * DAY),
    settingCount: 1 + (k % 40),
    isAssigned: k % 6 !== 0,
    templateReference: { templateId: '', templateFamily: 'none' },
    roleScopeTagIds: ['0'],
  }));
  const mobileApps = Array.from({ length: 3000 }, (_, k) => ({
    '@odata.type': [
      '#microsoft.graph.win32LobApp',
      '#microsoft.graph.iosStoreApp',
      '#microsoft.graph.androidManagedStoreApp',
      '#microsoft.graph.webApp',
      '#microsoft.graph.officeSuiteApp',
    ][k % 5],
    id: guid(65, k),
    displayName: `App ${k}${k % 50 === 0 ? " — Partners' edition" : ''}`,
    publisher: ['Example Corp', 'Fabrikam', 'Northwind'][k % 3],
    createdDateTime: iso(NOW_MS - k * DAY),
    lastModifiedDateTime: iso(NOW_MS - k * 3_600_000),
    publishingState: 'published',
    assignments: assignmentsFor(k + 5000),
  }));
  for (const list of [compliancePolicies, deviceConfigurations, mobileApps])
    for (const o of list) ids.add(String(o.id), 'intune', () => o);
  const autopilotDevices = virtual(Math.round(MD * 0.7), (k) => {
    const d = managedDevices[k % MD]!;
    return {
      id: guid(66, k),
      serialNumber: d.serialNumber,
      model: d.model,
      manufacturer: d.manufacturer,
      groupTag: ['Corp', 'Kiosk', 'Exec', ''][k % 4],
      enrollmentState: unit(seed, k, 210) < 0.1 ? 'notContacted' : 'enrolled',
      lastContactedDateTime: d.lastSyncDateTime,
      deploymentProfileAssignmentStatus:
        unit(seed, k, 211) < 0.05 ? 'notAssigned' : 'assignedUnkownSyncState',
      purchaseOrderIdentifier: '',
      managedDeviceId: unit(seed, k, 210) < 0.1 ? '00000000-0000-0000-0000-000000000000' : d.id,
      userPrincipalName: '',
    };
  });
  const settingStateSummaries = Array.from({ length: 100 }, (_, k) => ({
    id: guid(67, k),
    settingName: `Setting ${k}`,
    platformType: ['windows10AndLater', 'iOS', 'android', 'macOS'][k % 4],
    unknownDeviceCount: k % 5,
    notApplicableDeviceCount: k * 3,
    compliantDeviceCount: 1000 + k * 37,
    remediatedDeviceCount: 0,
    nonCompliantDeviceCount: k % 11,
    errorDeviceCount: k % 3,
    conflictDeviceCount: k % 2,
  }));

  // --- sites, service health, CA ---
  const S = scale.sites;
  const sites = virtual(S, (k) => {
    const g = k < teams.length ? teams[k]! : -1;
    const name = g >= 0 ? String(groups[g]!.displayName) : `Site ${k}`;
    return {
      id: `example.sharepoint.com,${guid(70, k)},${guid(71, k)}`,
      displayName: name,
      name: ascii(name).slice(0, 50) || `site${k}`,
      webUrl: `https://example.sharepoint.com/sites/${ascii(name).slice(0, 50) || `site${k}`}`,
      createdDateTime: iso(NOW_MS - unit(seed, k, 220) * 2000 * DAY),
      lastModifiedDateTime: iso(NOW_MS - unit(seed, k, 221) * 400 * DAY),
      isPersonalSite: false,
      siteCollection: { hostname: 'example.sharepoint.com' },
    };
  });
  const SERVICES = [
    'Exchange Online',
    'Microsoft Teams',
    'SharePoint Online',
    'Microsoft Entra',
    'Microsoft Intune',
    'Microsoft 365 suite',
    'OneDrive for Business',
    'Power BI',
  ];
  const serviceIssues = Array.from({ length: 600 }, (_, k) => ({
    id: `EX${100000 + k}`,
    title: `Users may be unable to access ${SERVICES[k % SERVICES.length]} feature ${k}`,
    service: SERVICES[k % SERVICES.length],
    feature: 'Feature',
    featureGroup: 'Group',
    classification: k % 3 === 0 ? 'incident' : 'advisory',
    status: k < 20 ? 'serviceDegradation' : k < 40 ? 'investigating' : 'serviceRestored',
    isResolved: k >= 40,
    startDateTime: iso(NOW_MS - k * 0.5 * DAY),
    endDateTime: k >= 40 ? iso(NOW_MS - k * 0.4 * DAY) : null,
    lastModifiedDateTime: iso(NOW_MS - k * 0.4 * DAY),
    impactDescription: 'Synthetic impact.',
    origin: 'microsoft',
    posts: [],
  }));
  const serviceMessages = Array.from({ length: 4000 }, (_, k) => ({
    id: `MC${800000 + k}`,
    title: `${SERVICES[k % SERVICES.length]}: change ${k}`,
    category: ['planForChange', 'stayInformed', 'preventOrFixIssue'][k % 3],
    severity: k % 17 === 0 ? 'high' : 'normal',
    isMajorChange: k % 9 === 0,
    services: [SERVICES[k % SERVICES.length]],
    tags: ['Updated message', 'Admin impact', 'Retirement'].slice(0, 1 + (k % 3)),
    actionRequiredByDateTime: k % 5 === 0 ? iso(NOW_MS + (k % 90) * DAY) : null,
    startDateTime: iso(NOW_MS - k * 0.2 * DAY),
    endDateTime: iso(NOW_MS + 180 * DAY),
    lastModifiedDateTime: iso(NOW_MS - k * 0.2 * DAY),
    body: { contentType: 'html', content: '<p>Synthetic message body.</p>' },
    viewPoint: { isRead: k % 2 === 0, isArchived: false, isFavorited: false },
  }));
  const healthOverviews = SERVICES.map((service, k) => ({
    id: ascii(service),
    service,
    status: k === 0 ? 'serviceDegradation' : 'serviceOperational',
  }));
  const caPolicies = Array.from({ length: 150 }, (_, k) => ({
    id: guid(80, k),
    displayName:
      k < 14
        ? `AF-Audit: Example ${k}`
        : `CA${String(k).padStart(3, '0')} ${['Require MFA', 'Block legacy auth', 'Require compliant device', 'Block countries'][k % 4]}`,
    state: ['enabled', 'disabled', 'enabledForReportingButNotEnforced'][k % 3],
    createdDateTime: iso(NOW_MS - k * 9 * DAY),
    modifiedDateTime: iso(NOW_MS - k * DAY),
    conditions: {
      users: {
        includeUsers: ['All'],
        excludeUsers: [],
        includeGroups: [],
        excludeGroups: k % 4 === 0 ? [groups[4]!.id] : [],
        includeRoles: [],
        excludeRoles: [],
      },
      applications: { includeApplications: ['All'], excludeApplications: [] },
      clientAppTypes: ['all'],
      locations: k % 4 === 3 ? { includeLocations: [guid(81, 0)], excludeLocations: [] } : null,
      platforms: null,
      signInRiskLevels: [],
      userRiskLevels: [],
    },
    grantControls: {
      operator: 'OR',
      builtInControls: [['mfa'], ['block'], ['compliantDevice'], ['block']][k % 4],
      customAuthenticationFactors: [],
      termsOfUse: [],
      authenticationStrength: null,
    },
    sessionControls: null,
  }));
  const namedLocations = Array.from({ length: 60 }, (_, k) => ({
    '@odata.type': k % 2 ? '#microsoft.graph.countryNamedLocation' : '#microsoft.graph.ipNamedLocation',
    id: guid(81, k),
    displayName: `Location ${k}`,
    createdDateTime: iso(NOW_MS - k * DAY),
    modifiedDateTime: iso(NOW_MS - k * DAY),
    ...(k % 2
      ? { countriesAndRegions: ['RU', 'KP'], includeUnknownCountriesAndRegions: false }
      : {
          isTrusted: k % 4 === 0,
          ipRanges: [{ '@odata.type': '#microsoft.graph.iPv4CidrRange', cidrAddress: `192.0.2.${k}/32` }],
        }),
  }));
  for (const list of [caPolicies, namedLocations])
    for (const o of list) ids.add(String(o.id), 'policy', () => o);

  const singletons: Record<string, GraphObject> = {
    '/policies/authorizationPolicy': {
      id: 'authorizationPolicy',
      allowInvitesFrom: 'everyone',
      allowedToSignUpEmailBasedSubscriptions: true,
      allowEmailVerifiedUsersToJoinOrganization: false,
      blockMsolPowerShell: false,
      guestUserRoleId: '10dae51f-b6af-4016-8d66-8c2a99b929b3',
      defaultUserRolePermissions: {
        allowedToCreateApps: true,
        allowedToCreateSecurityGroups: true,
        allowedToReadOtherUsers: true,
        permissionGrantPoliciesAssigned: ['ManagePermissionGrantsForSelf.microsoft-user-default-legacy'],
      },
    },
    '/policies/identitySecurityDefaultsEnforcementPolicy': {
      id: '00000000-0000-0000-0000-000000000005',
      isEnabled: false,
    },
    '/policies/authenticationMethodsPolicy': {
      id: 'authenticationMethodsPolicy',
      policyMigrationState: 'migrationComplete',
      registrationEnforcement: {
        authenticationMethodsRegistrationCampaign: {
          state: 'enabled',
          snoozeDurationInDays: 1,
          includeTargets: [],
          excludeTargets: [],
        },
      },
      authenticationMethodConfigurations: [
        'Fido2',
        'MicrosoftAuthenticator',
        'Sms',
        'Voice',
        'Email',
        'TemporaryAccessPass',
        'SoftwareOath',
      ].map((id, k) => ({ id, state: k < 4 ? 'enabled' : 'disabled' })),
    },
    '/policies/authenticationFlowsPolicy': {
      id: 'authenticationFlowsPolicy',
      selfServiceSignUp: { isEnabled: false },
    },
    '/policies/adminConsentRequestPolicy': {
      isEnabled: true,
      notifyReviewers: true,
      remindersEnabled: true,
      requestDurationInDays: 30,
      reviewers: [],
    },
    '/policies/deviceRegistrationPolicy': {
      id: 'deviceRegistrationPolicy',
      userDeviceQuota: 50,
      multiFactorAuthConfiguration: 'notRequired',
      azureADJoin: {
        isAdminConfigurable: true,
        allowedToJoin: { '@odata.type': '#microsoft.graph.allDeviceRegistrationMembership' },
      },
      localAdminPassword: { isEnabled: true },
    },
    '/policies/crossTenantAccessPolicy/default': {
      isServiceDefault: true,
      inboundTrust: {
        isMfaAccepted: false,
        isCompliantDeviceAccepted: false,
        isHybridAzureADJoinedDeviceAccepted: false,
      },
    },
    '/admin/reportSettings': { id: 'reportSettings', displayConcealedNames: false },
    '/deviceManagement': {
      id: 'deviceManagement',
      settings: { secureByDefault: true, deviceComplianceCheckinThresholdDays: 30 },
      intuneAccountId: guid(90, 0),
    },
    '/deviceManagement/managedDeviceOverview': {
      id: 'managedDeviceOverview',
      enrolledDeviceCount: MD,
      mdmEnrolledCount: MD,
      dualEnrolledDeviceCount: 0,
      deviceOperatingSystemSummary: {
        androidCount: Math.round(MD * 0.1),
        iosCount: Math.round(MD * 0.15),
        macOSCount: Math.round(MD * 0.05),
        windowsMobileCount: 0,
        windowsCount: Math.round(MD * 0.7),
        unknownCount: 0,
      },
      deviceExchangeAccessStateSummary: { allowedDeviceCount: MD },
    },
    '/deviceManagement/deviceCompliancePolicyDeviceStateSummary': {
      id: 'deviceCompliancePolicyDeviceStateSummary',
      inGracePeriodCount: Math.round(MD * 0.03),
      configManagerCount: 0,
      unknownDeviceCount: Math.round(MD * 0.02),
      notApplicableDeviceCount: 0,
      compliantDeviceCount: Math.round(MD * 0.85),
      remediatedDeviceCount: 0,
      nonCompliantDeviceCount: Math.round(MD * 0.1),
      errorDeviceCount: 5,
      conflictDeviceCount: 2,
    },
    '/reports/authenticationMethods/usersRegisteredByFeature': {
      totalUserCount: memberIdx.length,
      userTypes: 'all',
      userRoles: 'all',
      userRegistrationFeatureCounts: [
        { feature: 'ssprRegistered', userCount: Math.round(memberIdx.length * 0.9) },
        { feature: 'ssprEnabled', userCount: memberIdx.length },
        { feature: 'ssprCapable', userCount: Math.round(memberIdx.length * 0.9) },
        { feature: 'passwordlessCapable', userCount: Math.round(memberIdx.length * 0.3) },
        { feature: 'mfaCapable', userCount: Math.round(memberIdx.length * 0.88) },
      ],
    },
    '/reports/authenticationMethods/usersRegisteredByMethod': {
      totalUserCount: memberIdx.length,
      userTypes: 'all',
      userRoles: 'all',
      userRegistrationMethodCounts: [
        {
          authenticationMethod: 'microsoftAuthenticatorPush',
          userCount: Math.round(memberIdx.length * 0.75),
        },
        { authenticationMethod: 'mobilePhone', userCount: Math.round(memberIdx.length * 0.12) },
        { authenticationMethod: 'windowsHelloForBusiness', userCount: Math.round(memberIdx.length * 0.3) },
      ],
    },
    '/policies/authenticationStrengthPolicies': {
      value: [
        {
          id: '00000000-0000-0000-0000-000000000002',
          displayName: 'Multifactor authentication',
          policyType: 'builtIn',
          allowedCombinations: ['password,microsoftAuthenticatorPush'],
        },
        {
          id: '00000000-0000-0000-0000-000000000004',
          displayName: 'Phishing-resistant MFA',
          policyType: 'builtIn',
          allowedCombinations: ['fido2', 'windowsHelloForBusiness'],
        },
      ],
    } as GraphObject,
    '/deviceManagement/applePushNotificationCertificate': {
      id: 'apns',
      appleIdentifier: 'apns@example.com',
      topicIdentifier: 'com.apple.mgmt.External.example',
      expirationDateTime: '2026-11-05T00:00:00Z',
      lastModifiedDateTime: '2025-11-05T00:00:00Z',
      certificateSerialNumber: '0A1B2C',
    },
    '/deviceManagement/androidManagedStoreAccountEnterpriseSettings': {
      id: 'androidManagedStoreAccountEnterpriseSettings',
      bindStatus: 'boundAndValidated',
      lastAppSyncDateTime: NOW_ISO,
      lastAppSyncStatus: 'success',
      ownerUserPrincipalName: 'android@example.com',
      enrollmentTarget: 'targetedAsEnrollmentRestrictions',
    },
    '/deviceManagement/windowsAutopilotSettings': {
      id: 'windowsAutopilotSettings',
      lastSyncDateTime: NOW_ISO,
      lastManualSyncTriggerDateTime: NOW_ISO,
      syncStatus: 'completed',
    },
    '/groupSettings': {
      value: [
        {
          id: guid(91, 0),
          displayName: 'Group.Unified',
          templateId: '62375ab9-6b52-47ed-826b-58e47e0e304b',
          values: [{ name: 'EnableGroupCreation', value: 'true' }],
        },
      ],
    } as GraphObject,
  };

  // --- usage reports (JSON form of the reports API, one row per user/site/team) ---
  const reportDate = dateOnly(NOW_MS - 2 * DAY);
  const licensedIdx: number[] = [];
  for (let i = 0; i < N; i++) if ((users[i]!.assignedLicenses as unknown[]).length) licensedIdx.push(i);
  const lastActivity = (i: number, salt: number) => {
    const r = unit(seed, i, salt);
    return r < 0.1 ? null : dateOnly(NOW_MS - r * 200 * DAY);
  };
  const usageReports: Record<string, Collection> = {
    getOffice365ActiveUserDetail: virtual(licensedIdx.length, (k) => {
      const i = licensedIdx[k]!;
      const u = users[i]!;
      return {
        reportRefreshDate: reportDate,
        userPrincipalName: u.userPrincipalName,
        displayName: u.displayName,
        isDeleted: false,
        deletedDate: null,
        hasExchangeLicense: true,
        hasOneDriveLicense: true,
        hasSharePointLicense: true,
        hasSkypeForBusinessLicense: false,
        hasYammerLicense: false,
        hasTeamsLicense: true,
        exchangeLastActivityDate: lastActivity(i, 230),
        oneDriveLastActivityDate: lastActivity(i, 231),
        sharePointLastActivityDate: lastActivity(i, 232),
        skypeForBusinessLastActivityDate: null,
        yammerLastActivityDate: null,
        teamsLastActivityDate: lastActivity(i, 233),
        exchangeLicenseAssignDate: dateOnly(Date.parse(String(u.createdDateTime))),
        assignedProducts: ['MICROSOFT 365 E3'],
      };
    }),
    getMailboxUsageDetail: virtual(licensedIdx.length, (k) => {
      const i = licensedIdx[k]!;
      const u = users[i]!;
      const used = Math.floor(unit(seed, i, 234) * 100 * 1024 ** 3);
      return {
        reportRefreshDate: reportDate,
        userPrincipalName: u.userPrincipalName,
        displayName: u.displayName,
        isDeleted: false,
        createdDate: dateOnly(Date.parse(String(u.createdDateTime))),
        lastActivityDate: lastActivity(i, 230),
        itemCount: Math.floor(used / 80_000),
        storageUsedInBytes: used,
        deletedItemCount: 100,
        deletedItemSizeInBytes: 1_000_000,
        deletedItemQuotaInBytes: 30 * 1024 ** 3,
        issueWarningQuotaInBytes: 98 * 1024 ** 3,
        prohibitSendQuotaInBytes: 99 * 1024 ** 3,
        prohibitSendReceiveQuotaInBytes: 100 * 1024 ** 3,
        hasArchive: unit(seed, i, 235) < 0.3,
        recipientType: 'User',
      };
    }),
    getOneDriveUsageAccountDetail: virtual(licensedIdx.length, (k) => {
      const i = licensedIdx[k]!;
      const u = users[i]!;
      return {
        reportRefreshDate: reportDate,
        siteUrl: `https://example-my.sharepoint.com/personal/${String(u.mailNickname).replace(/\./g, '_')}_example_com`,
        ownerDisplayName: u.displayName,
        ownerPrincipalName: u.userPrincipalName,
        isDeleted: false,
        lastActivityDate: lastActivity(i, 231),
        fileCount: Math.floor(unit(seed, i, 236) * 20_000),
        activeFileCount: Math.floor(unit(seed, i, 237) * 500),
        storageUsedInBytes: Math.floor(unit(seed, i, 238) * 1024 ** 4),
        storageAllocatedInBytes: 1024 ** 4,
      };
    }),
    getSharePointSiteUsageDetail: virtual(S, (k) => {
      const s = sites.at(k);
      return {
        reportRefreshDate: reportDate,
        siteId: String(s.id).split(',')[1],
        siteUrl: s.webUrl,
        ownerDisplayName: 'Site owner',
        ownerPrincipalName: users[k % N]!.userPrincipalName,
        isDeleted: false,
        lastActivityDate: lastActivity(k, 239),
        fileCount: Math.floor(unit(seed, k, 240) * 100_000),
        activeFileCount: Math.floor(unit(seed, k, 241) * 1000),
        pageViewCount: Math.floor(unit(seed, k, 242) * 5000),
        visitedPageCount: 10,
        anonymousLinkCount: k % 23 === 0 ? 3 : 0,
        companyLinkCount: 2,
        secureLinkForGuestCount: k % 7 === 0 ? 1 : 0,
        secureLinkForMemberCount: 4,
        storageUsedInBytes: Math.floor(unit(seed, k, 243) * 25 * 1024 ** 4),
        storageAllocatedInBytes: 25 * 1024 ** 4,
        rootWebTemplate: 'Group',
        ownerPrincipalNameGuest: null,
      };
    }),
    getTeamsTeamActivityDetail: virtual(teams.length, (k) => {
      const g = groups[teams[k]!]!;
      return {
        reportRefreshDate: reportDate,
        teamId: g.id,
        teamName: g.displayName,
        teamType: g.visibility,
        isDeleted: false,
        lastActivityDate: lastActivity(k, 244),
        details: [
          {
            reportPeriod: 90,
            activeUsers: Math.floor(unit(seed, k, 245) * 200),
            activeExternalUsers: k % 10 === 0 ? 2 : 0,
            guests: k % 10 === 0 ? 3 : 0,
            activeChannels: 4,
            activeSharedChannels: 0,
            postMessages: 100,
            replyMessages: 50,
            channelMessages: 150,
            reactions: 30,
            meetingsOrganized: 12,
            urgentMessages: 0,
            mentions: 10,
          },
        ],
      };
    }),
  };
  const countsRows = (days: number, salt: number, row: (d: number) => GraphObject): Collection =>
    virtual(days, (d) => ({
      reportRefreshDate: reportDate,
      reportDate: dateOnly(NOW_MS - (d + 2) * DAY),
      reportPeriod: String(days),
      ...row(d + salt * 0),
    }));
  const counts: Record<string, (days: number) => Collection> = {
    getOffice365ActiveUserCounts: (days) =>
      countsRows(days, 1, () => ({
        office365: Math.round(N * 0.8),
        exchange: Math.round(N * 0.75),
        oneDrive: Math.round(N * 0.6),
        sharePoint: Math.round(N * 0.5),
        skypeForBusiness: 0,
        yammer: 0,
        teams: Math.round(N * 0.7),
      })),
    getOffice365ServicesUserCounts: (days) =>
      countsRows(days, 2, () => ({
        exchangeActive: Math.round(N * 0.75),
        exchangeInactive: Math.round(N * 0.1),
        oneDriveActive: Math.round(N * 0.6),
        oneDriveInactive: Math.round(N * 0.2),
        teamsActive: Math.round(N * 0.7),
        teamsInactive: Math.round(N * 0.15),
        office365Active: Math.round(N * 0.8),
        office365Inactive: Math.round(N * 0.1),
      })),
    getEmailActivityCounts: (days) =>
      countsRows(days, 3, (d) => ({
        send: 100_000 + d,
        receive: 400_000 + d,
        read: 300_000 + d,
        meetingCreated: 20_000,
        meetingInteracted: 50_000,
      })),
    getTeamsUserActivityCounts: (days) =>
      countsRows(days, 4, () => ({
        teamChatMessages: 200_000,
        privateChatMessages: 500_000,
        calls: 30_000,
        meetings: 40_000,
        postMessages: 10_000,
        replyMessages: 5_000,
        urgentMessages: 10,
      })),
    getOneDriveActivityFileCounts: (days) =>
      countsRows(days, 5, () => ({
        viewedOrEdited: 300_000,
        synced: 900_000,
        sharedInternally: 20_000,
        sharedExternally: 2_000,
      })),
  };
  const usageReport = (name: string) => {
    const m = /^(\w+)\(period='D(\d+)'\)$/.exec(name);
    if (!m) return undefined;
    if (usageReports[m[1]!]) return usageReports[m[1]!];
    const c = counts[m[1]!];
    return c ? c(Number(m[2])) : undefined;
  };

  const detectedApps = (device: number) =>
    virtual(20 + (hash32(seed, device, 250) % 120), (k) => ({
      id: guid(92, device * 200 + k),
      displayName:
        ['Microsoft Edge', 'Teams', 'Office', 'Zoom', 'Notepad++', '7-Zip', 'Chrome'][k % 7]! +
        (k > 6 ? ` ${k}` : ''),
      version: `1.${k}.${device % 10}`,
      sizeInByte: 1000 * k,
      deviceCount: 1,
      publisher: 'Example',
      platform: 'windows',
    }));
  const windowsDevices: number[] = [];
  for (let d = 0; d < ED; d++) if (entraDevices[d]!.operatingSystem === 'Windows') windowsDevices.push(d);
  const bitlockerKeys = virtual(Math.round(windowsDevices.length * 0.9), (k) => ({
    id: guid(93, k),
    createdDateTime: iso(NOW_MS - unit(seed, k, 260) * 500 * DAY),
    deviceId: entraDevices[windowsDevices[k]!]!.deviceId,
    volumeType: 'operatingSystemVolume',
  }));

  return {
    scale,
    seed,
    ids,
    organization,
    domains,
    users,
    managerOf,
    groups,
    allCompany: 0,
    groupUserMembers: (g) => ({ count: gCount[g]!, at: (k) => (gStart[g]! + k * gStride[g]!) % N }),
    groupHasUser,
    nestedGroups,
    groupOwners,
    userGroups,
    managedDevices,
    entraDevices,
    deviceOwner,
    applications,
    servicePrincipals,
    appOwners,
    subscribedSkus,
    roleDefinitions,
    roleAssignments,
    roleEligibilities,
    signIns,
    directoryAudits,
    riskyUsers,
    riskDetections,
    userRegistrationDetails,
    oauth2PermissionGrants,
    graphAppRoleAssignedTo,
    compliancePolicies,
    deviceConfigurations,
    configurationPolicies,
    mobileApps,
    autopilotDevices,
    settingStateSummaries,
    teams,
    sites,
    serviceIssues,
    serviceMessages,
    healthOverviews,
    caPolicies,
    namedLocations,
    singletons,
    usageReport,
    detectedApps,
    bitlockerKeys,
  };
}

export { materialised };
