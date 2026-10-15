import type { StatusValue } from '@adminforge/ui';

/** Synthetic, deterministic showcase data (Example Org, example.com). Seeded so screenshots are stable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20261015);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;

function guid(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const FIRST = [
  'Adele',
  'Alex',
  'Diego',
  'Grady',
  'Henrietta',
  'Isaiah',
  'Johanna',
  'Joni',
  'Lee',
  'Lidia',
  'Lynne',
  'Megan',
  'Miriam',
  'Nestor',
  'Patti',
  'Pradeep',
  'Ruth',
  'Sanjay',
  'Tomasz',
  'Yuki',
  'Zainab',
  'Oluwaseun',
  'Ingrid',
  'Mateo',
];
const LAST = [
  'Vance',
  'Wilber',
  'Siciliani',
  'Archie',
  'Mueller',
  'Lee',
  'Kaufman',
  'Sherman',
  'Gu',
  'Holloway',
  'Robbins',
  'Bowen',
  'Graham',
  'Wilke',
  'Fernandez',
  'Gupta',
  'Okafor',
  'Nowak',
  'Tanaka',
  'Haddad',
  'Lindqvist',
  'Ortega',
];
const DEPARTMENTS = [
  'Engineering',
  'Finance',
  'Human Resources',
  'IT Operations',
  'Legal',
  'Marketing',
  'Sales',
  'Security',
];
const LICENCES = ['M365 E5', 'M365 E3', 'Entra ID P2', 'Intune P1', 'Power BI Pro', 'Visio P2'];

export interface ShowcaseUser {
  id: string;
  name: string;
  upn: string;
  type: 'Member' | 'Guest';
  status: StatusValue;
  department: string;
  lastSignIn: string | null;
  licences: string[];
  mfa: number;
}

const STATUSES: StatusValue[] = [
  { tone: 'ok', label: 'Enabled' },
  { tone: 'ok', label: 'Enabled' },
  { tone: 'ok', label: 'Enabled' },
  { tone: 'ok', label: 'Enabled' },
  { tone: 'neutral', label: 'Disabled' },
  { tone: 'warn', label: 'Risky' },
  { tone: 'crit', label: 'Compromised' },
];

export function makeUsers(count: number, now: number = Date.now()): ShowcaseUser[] {
  return Array.from({ length: count }, (_, i) => {
    const first = pick(FIRST);
    const last = pick(LAST);
    const guest = rand() < 0.12;
    const upn = guest
      ? `${first.toLowerCase()}_partner.example#ext#@example.com`
      : `${first.toLowerCase()}.${last.toLowerCase()}${i > 40 ? i : ''}@example.com`;
    const daysAgo = rand() < 0.08 ? null : Math.floor(rand() * rand() * 120 * 86_400_000);
    return {
      id: guid(),
      name: `${first} ${last}`,
      upn,
      type: guest ? 'Guest' : 'Member',
      status: pick(STATUSES),
      department: guest ? 'External' : pick(DEPARTMENTS),
      lastSignIn: daysAgo == null ? null : new Date(now - daysAgo).toISOString(),
      licences: guest ? [] : LICENCES.filter(() => rand() < 0.35),
      mfa: Math.floor(rand() * 5),
    };
  });
}

export const SAMPLE_GUID = '3f2a8c71-5d0e-4b6a-9e1f-0c4d2b7a9c1d';
export const SAMPLE_REQUEST = '7b1e0f42-93ad-4c58-b2e6-5a0d81c4f3e9';

const days = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 9, 2 + i));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
});

export const SIGN_INS = {
  categories: days,
  series: [
    {
      name: 'Interactive',
      data: [4120, 4380, 4290, 4510, 4470, 1910, 1720, 4390, 4610, 4580, 4720, 4650, 2010, 1830],
    },
    {
      name: 'Non-interactive',
      data: [9800, 10240, 10110, 10690, 10520, 6120, 5890, 10350, 10980, 11020, 11240, 11090, 6400, 6010],
    },
  ],
};

export const DEVICES_BY_OS = {
  categories: ['Windows', 'macOS', 'iOS', 'Android', 'Linux'],
  series: [{ name: 'Devices', data: [2140, 612, 1380, 744, 96] }],
};

export const GRAPH_LATENCY = {
  categories: days,
  series: [
    { name: 'Graph', data: [182, 176, 190, 214, 201, 168, 160, 188, 240, 232, 205, 198, 171, 166] },
    { name: 'ARM', data: [240, 251, 238, 262, 270, 231, 228, 249, 301, 288, 266, 259, 236, 229] },
    { name: 'Exchange', data: [410, 398, 420, 455, 431, 380, 372, 418, 470, 462, 440, 428, 389, 377] },
  ],
};

export const KQL = `SigninLogs
| where TimeGenerated > ago(24h)
| where ResultType != 0
| summarize Failures = count() by UserPrincipalName, ResultDescription
| order by Failures desc
| take 20`;
