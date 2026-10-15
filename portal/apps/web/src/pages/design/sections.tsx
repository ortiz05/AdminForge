import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowClockwiseIcon,
  Avatar,
  Badge,
  Brand,
  Button,
  Chart,
  Checkbox,
  CodeBlock,
  CommandIcon,
  ConfirmDialog,
  CopyIcon,
  DataTable,
  Dialog,
  DotsThreeIcon,
  DownloadSimpleIcon,
  Drawer,
  EmptyState,
  ErrorState,
  GearIcon,
  IconButton,
  IdChip,
  Kbd,
  Kpi,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Meter,
  modKey,
  PageHeader,
  Panel,
  PlusIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProvenanceFooter,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonText,
  Sparkline,
  StatusPill,
  STATUS_TONES,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  TextField,
  Timeline,
  Tooltip,
  TrashIcon,
  UserMinusIcon,
  useToast,
  MagnifyingGlassIcon,
  type DataColumn,
} from '@adminforge/ui';
import { RouterLink } from '../../app/RouterLink';
import { useShell } from '../../app/shell-context';
import { WriteAction } from '../../app/WriteAction';
import {
  DEVICES_BY_OS,
  GRAPH_LATENCY,
  KQL,
  makeUsers,
  SAMPLE_GUID,
  SAMPLE_REQUEST,
  SIGN_INS,
  type ShowcaseUser,
} from './fixtures';

function Specimen({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="mb-2.5 font-mono text-2xs text-fg-3">{label}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const grid2 = 'grid gap-(--af-gap-grid) lg:grid-cols-2';
const grid3 = 'grid gap-(--af-gap-grid) md:grid-cols-2 xl:grid-cols-3';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

// ── Identity & type ──────────────────────────────────────────────────────────

export function IdentitySection() {
  return (
    <div className={grid2}>
      <Panel eyebrow="Brand" title="Wordmark and anvil">
        <div className="flex flex-col gap-5">
          <Brand size="lg" />
          <div className="flex flex-wrap items-center gap-6">
            <Brand size="md" />
            <Brand size="sm" />
            <Brand size="md" compact />
          </div>
          <p className="text-sm text-fg-3">
            “Admin” in fg-2 at 500, “Forge” in fg at 700, Archivo at width 118. The anvil is temper blue;
            ember never appears in the brand.
          </p>
        </div>
      </Panel>
      <Panel eyebrow="Typography" title="Three faces, three jobs">
        <div className="flex flex-col gap-4">
          <div>
            <p className="af-eyebrow">Eyebrow · Archivo 85 % · 11 px</p>
            <p className="af-page-title mt-1">Page title · Archivo 112 %</p>
          </div>
          <p className="text-fg-2">
            Body and UI text is Atkinson Hyperlegible Next, chosen so I, l and 1, O and 0 never get confused
            in names like Il1ana O’Neil.
          </p>
          <p className="font-mono text-sm text-fg-2">
            Mono · 0O 1lI · 3f2a8c71-5d0e-4b6a · /users?$filter=accountEnabled eq false
          </p>
          <div className="flex items-baseline gap-4">
            <span className="af-kpi-value text-fg">12,408</span>
            <span className="text-sm text-fg-3">KPI numerals · Archivo 600</span>
          </div>
        </div>
      </Panel>
    </div>
  );
}

// ── Colour ───────────────────────────────────────────────────────────────────

const SWATCHES: Array<{
  group: string;
  note?: string;
  items: Array<{ name: string; className: string; ink?: string }>;
}> = [
  {
    group: 'Surfaces',
    items: [
      { name: 'canvas', className: 'bg-canvas' },
      { name: 'panel', className: 'bg-panel' },
      { name: 'raised', className: 'bg-raised' },
      { name: 'sunken', className: 'bg-sunken' },
      { name: 'hover', className: 'bg-hover' },
      { name: 'selected', className: 'bg-selected' },
    ],
  },
  {
    group: 'Lines and text',
    items: [
      { name: 'line', className: 'bg-line' },
      { name: 'line-strong', className: 'bg-line-strong' },
      { name: 'fg', className: 'bg-fg' },
      { name: 'fg-2', className: 'bg-fg-2' },
      { name: 'fg-3', className: 'bg-fg-3' },
      { name: 'focus', className: 'bg-focus' },
    ],
  },
  {
    group: 'Temper (accent)',
    items: [
      { name: 'accent', className: 'bg-accent', ink: 'text-on-accent' },
      { name: 'accent-strong', className: 'bg-accent-strong', ink: 'text-on-accent' },
      { name: 'accent-subtle', className: 'bg-accent-subtle', ink: 'text-accent' },
    ],
  },
  {
    group: 'Ember (armed)',
    note: 'Write mode only. Never in charts, status or branding.',
    items: [
      { name: 'armed', className: 'bg-armed', ink: 'text-on-armed' },
      { name: 'armed-subtle', className: 'bg-armed-subtle', ink: 'text-armed' },
    ],
  },
  {
    group: 'Status: patina · straw · cinder',
    items: [
      { name: 'ok', className: 'bg-ok', ink: 'text-fg-inverse' },
      { name: 'warn', className: 'bg-warn', ink: 'text-fg-inverse' },
      { name: 'crit', className: 'bg-crit', ink: 'text-fg-inverse' },
      { name: 'ok-subtle', className: 'bg-ok-subtle', ink: 'text-ok' },
      { name: 'warn-subtle', className: 'bg-warn-subtle', ink: 'text-warn' },
      { name: 'crit-subtle', className: 'bg-crit-subtle', ink: 'text-crit' },
    ],
  },
  {
    group: 'Chart palette (fixed order)',
    items: [
      { name: 'chart-1', className: 'bg-chart-1' },
      { name: 'chart-2', className: 'bg-chart-2' },
      { name: 'chart-3', className: 'bg-chart-3' },
      { name: 'chart-4', className: 'bg-chart-4' },
      { name: 'chart-5', className: 'bg-chart-5' },
      { name: 'chart-6', className: 'bg-chart-6' },
    ],
  },
];

export function ColourSection() {
  return (
    <div className={grid3}>
      {SWATCHES.map((g) => (
        <Panel key={g.group} eyebrow="Tokens" title={g.group} description={g.note}>
          <ul className="grid grid-cols-3 gap-3">
            {g.items.map((it) => (
              <li key={it.name} className="flex flex-col gap-1.5">
                <span
                  className={`flex h-12 items-end rounded-md border border-line p-1.5 text-2xs font-semibold ${it.className} ${it.ink ?? ''}`}
                  aria-hidden
                >
                  {it.ink ? 'Aa' : ''}
                </span>
                <span className="truncate font-mono text-2xs text-fg-2">{it.name}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────────

export function ButtonsSection() {
  return (
    <div className={grid2}>
      <Panel eyebrow="Button" title="Intents, sizes and states">
        <div className="flex flex-col gap-6">
          <Specimen label="intent · md">
            <Button intent="primary">Run playbook</Button>
            <Button>Export CSV</Button>
            <Button intent="ghost">Cancel</Button>
            <Button intent="danger">Delete group</Button>
            <Button intent="armed">Continue to sign-in</Button>
          </Specimen>
          <Specimen label="size · sm">
            <Button size="sm" intent="primary">
              <PlusIcon size={14} aria-hidden />
              New schedule
            </Button>
            <Button size="sm">
              <DownloadSimpleIcon size={14} aria-hidden />
              Export
            </Button>
            <Button size="sm" intent="ghost">
              Clear
            </Button>
          </Specimen>
          <Specimen label="locked · pending · disabled">
            <Button locked="Arm write access to use this.">Disable sign-in</Button>
            <Button intent="primary" pending>
              Saving
            </Button>
            <Button disabled>Unavailable</Button>
          </Specimen>
        </div>
      </Panel>
      <Panel eyebrow="Actions" title="Icon buttons and write actions">
        <div className="flex flex-col gap-6">
          <Specimen label="IconButton · ghost / secondary / sm">
            <IconButton label="Refresh" icon={<ArrowClockwiseIcon size={16} />} />
            <IconButton label="Settings" intent="secondary" icon={<GearIcon size={16} />} />
            <IconButton label="Copy link" size="sm" icon={<CopyIcon size={14} />} />
            <IconButton
              label="Delete"
              icon={<TrashIcon size={16} />}
              locked="Arm write access to use this."
            />
          </Specimen>
          <Specimen label="WriteAction · locked in read mode, ember dot when armed">
            <WriteAction>
              <UserMinusIcon size={14} aria-hidden />
              Disable sign-in
            </WriteAction>
            <WriteAction intent="danger">Revoke sessions</WriteAction>
          </Specimen>
          <p className="text-sm text-fg-3">
            Locked actions stay visible and focusable, explain why, and do nothing. Arm write access in the
            rail to see them unlock.
          </p>
        </div>
      </Panel>
    </div>
  );
}

// ── Status & identifiers ─────────────────────────────────────────────────────

const TONE_LABEL = {
  ok: 'Healthy',
  warn: 'Degraded',
  crit: 'Interruption',
  info: 'Investigating',
  neutral: 'Disabled',
} as const;

export function StatusSection() {
  return (
    <div className={grid2}>
      <Panel eyebrow="State" title="Status pills and badges">
        <div className="flex flex-col gap-6">
          <Specimen label="StatusPill · md">
            {STATUS_TONES.map((t) => (
              <StatusPill key={t} status={t}>
                {TONE_LABEL[t]}
              </StatusPill>
            ))}
          </Specimen>
          <Specimen label="StatusPill · sm">
            {STATUS_TONES.map((t) => (
              <StatusPill key={t} status={t} size="sm">
                {TONE_LABEL[t]}
              </StatusPill>
            ))}
          </Specimen>
          <Specimen label="Badge">
            <Badge>Member</Badge>
            <Badge tone="accent">Default</Badge>
            <Badge tone="outline">Initial</Badge>
            <Badge tone="ok">Compliant</Badge>
            <Badge tone="warn">Expiring</Badge>
            <Badge tone="crit">Risky</Badge>
            <Badge tone="outline" mono>
              forbidden
            </Badge>
          </Specimen>
        </div>
      </Panel>
      <Panel eyebrow="Identifiers" title="IDs, keys and people">
        <div className="flex flex-col gap-6">
          <Specimen label="IdChip">
            <IdChip value={SAMPLE_GUID} />
            <IdChip value={SAMPLE_GUID} label="Object ID" />
            <IdChip
              value="/subscriptions/0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0/resourceGroups/rg-example"
              label="Resource"
            />
          </Specimen>
          <Specimen label="Kbd">
            <Kbd keys={[modKey(), 'K']} />
            <Kbd keys="Esc" />
            <Kbd keys={['Shift', '↑']} />
          </Specimen>
          <Specimen label="Avatar">
            <Avatar name="Mock Engineer" />
            <Avatar name="Adele Vance" />
            <Avatar name="Yuki" size="sm" />
          </Specimen>
        </div>
      </Panel>
    </div>
  );
}

// ── Data display ─────────────────────────────────────────────────────────────

const TREND = [410, 420, 415, 432, 440, 438, 452, 461, 455, 470, 482, 496];

export function DataDisplaySection() {
  return (
    <div className="flex flex-col gap-(--af-gap-grid)">
      <div className="grid grid-cols-2 gap-(--af-gap-grid) xl:grid-cols-4">
        <Kpi label="Users" value={12408} hint="Members and guests" />
        <Kpi
          label="Sign-ins today"
          value={4650}
          delta={{ value: '+3.2%', direction: 'up', good: true, period: 'vs last Monday' }}
          trend={TREND}
        />
        <Kpi
          label="Services with issues"
          value={2}
          status={{ tone: 'warn', label: '2 services' }}
          hint="Microsoft 365 service health"
        />
        <Kpi label="Stale devices" value={null} loading />
      </div>
      <div className={grid3}>
        <Panel
          eyebrow="Meter"
          title="Utilisation"
          footer={
            <ProvenanceFooter
              service="graph"
              path="/subscribedSkus"
              ms={182}
              cachedAt={ago(30_000)}
              requestId={SAMPLE_REQUEST}
            />
          }
        >
          <div className="flex flex-col gap-4">
            <Meter value={312} max={500} label="Microsoft 365 E3" />
            <Meter value={441} max={500} label="Microsoft 365 E5" />
            <Meter value={500} max={500} label="Power BI Pro" />
          </div>
        </Panel>
        <Panel
          eyebrow="Sparkline"
          title="Trends without a chart runtime"
          footer={<ProvenanceFooter service="graph" path="/reports/getEmailActivityCounts" ms={1240} />}
        >
          <div className="flex flex-col gap-3">
            <Sparkline
              data={TREND}
              label="Daily active users, last 12 days, rising from 410 to 496"
              width={280}
              height={40}
            />
            <Sparkline
              data={[9, 7, 8, 6, 7, 5, 4, 5, 3, 2, 3, 2]}
              tone="accent"
              label="Open incidents, last 12 days, falling from 9 to 2"
              width={280}
              height={40}
            />
          </div>
        </Panel>
        <Panel eyebrow="Timeline" title="Run steps">
          <Timeline
            label="Offboarding run"
            items={[
              {
                id: '1',
                title: 'Disable sign-in',
                time: ago(8 * 60_000),
                status: 'ok',
                statusLabel: 'Succeeded',
                description: 'adele.vance@example.com',
              },
              {
                id: '2',
                title: 'Revoke sessions',
                time: ago(7 * 60_000),
                status: 'ok',
                statusLabel: 'Succeeded',
              },
              {
                id: '3',
                title: 'Remove licences',
                time: ago(5 * 60_000),
                status: 'warn',
                statusLabel: 'Partially succeeded',
                description: '1 of 3 licences is group-assigned',
              },
              {
                id: '4',
                title: 'Approval: convert mailbox to shared',
                time: ago(60_000),
                status: 'info',
                statusLabel: 'Waiting',
              },
            ]}
          />
        </Panel>
      </div>
      <CodeBlock title="Failed sign-ins · KQL" language="kql" code={KQL} />
    </div>
  );
}

// ── Forms ────────────────────────────────────────────────────────────────────

export function FormsSection() {
  const [view, setView] = useState('chart');
  const [switchOn, setSwitchOn] = useState(true);
  return (
    <div className={grid2}>
      <Panel eyebrow="Text" title="Fields">
        <div className="flex flex-col gap-4">
          <TextField
            label="Display name"
            defaultValue="Adele Vance"
            hint="Shown in the global address list."
          />
          <TextField
            label="User principal name"
            defaultValue="adele.vance@"
            error="Enter a full address, like name@example.com."
          />
          <TextField
            label="Search users"
            hideLabel
            placeholder="Search users…"
            leading={<MagnifyingGlassIcon size={14} />}
          />
          <TextField label="Object ID" value={SAMPLE_GUID} readOnly disabled inputClassName="font-mono" />
          <Textarea label="Justification" optional placeholder="Why is this change needed?" />
        </div>
      </Panel>
      <Panel eyebrow="Choice" title="Selects, toggles and segments">
        <div className="flex flex-col gap-5">
          <Select
            label="Usage location"
            defaultValue="GB"
            options={[
              { value: 'GB', label: 'United Kingdom' },
              { value: 'US', label: 'United States' },
              { value: 'DE', label: 'Germany' },
              { value: 'JP', label: 'Japan' },
            ]}
          />
          <div className="flex flex-col gap-3">
            <Checkbox
              label="Require MFA re-registration"
              defaultChecked
              description="Users register methods again at next sign-in."
            />
            <Checkbox label="Notify the user's manager" />
            <Checkbox label="Some groups selected" checked="indeterminate" />
            <Checkbox label="Hide from the address list" disabled />
          </div>
          <div className="flex flex-col gap-3">
            <Switch
              label="Block sign-in"
              checked={switchOn}
              onCheckedChange={setSwitchOn}
              description="Takes effect within minutes."
            />
            <Switch label="Send summary email" />
          </div>
          <Specimen label="SegmentedControl">
            <SegmentedControl
              aria-label="View"
              value={view}
              onValueChange={setView}
              options={[
                { value: 'chart', label: 'Chart' },
                { value: 'table', label: 'Table' },
                { value: 'raw', label: 'Raw' },
              ]}
            />
            <SegmentedControl
              size="sm"
              aria-label="Range"
              value="7d"
              onValueChange={() => {}}
              options={[
                { value: '24h', label: '24 h' },
                { value: '7d', label: '7 d' },
                { value: '30d', label: '30 d' },
              ]}
            />
          </Specimen>
        </div>
      </Panel>
    </div>
  );
}

// ── Overlays ─────────────────────────────────────────────────────────────────

export function OverlaysSection() {
  const { toast } = useToast();
  const { openPalette } = useShell();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState(false);
  return (
    <div className={grid2}>
      <Panel eyebrow="Modal" title="Dialogs and sheets">
        <div className="flex flex-col gap-5">
          <Specimen label="Dialog · ConfirmDialog (typed) · Drawer">
            <Button onClick={() => setDialog(true)}>Open dialog</Button>
            <ConfirmDialog
              trigger={<Button intent="danger">Delete group…</Button>}
              title="Delete SG-Example-Finance?"
              description="Members lose access granted through this group. Deleted groups can be restored for 30 days."
              confirmLabel="Delete group"
              confirmText="SG-Example-Finance"
              onConfirm={() => {
                toast({
                  tone: 'ok',
                  title: 'Group deleted',
                  description: 'SG-Example-Finance can be restored for 30 days.',
                });
              }}
            />
            <Button onClick={() => setDrawer(true)}>Open drawer</Button>
          </Specimen>
          <Specimen label="Inspector (?inspect=) · command palette">
            <Button
              onClick={() =>
                void navigate({
                  to: '.',
                  search: (prev: Record<string, unknown>) => ({ ...prev, inspect: `user:${SAMPLE_GUID}` }),
                })
              }
            >
              Inspect a user
            </Button>
            <Button onClick={openPalette}>
              <CommandIcon size={14} aria-hidden />
              Command palette
            </Button>
          </Specimen>
          <Dialog
            open={dialog}
            onOpenChange={setDialog}
            title="Add members to SG-Example-Finance"
            description="Members get access to everything assigned to this group."
            footer={
              <>
                <Button intent="ghost" onClick={() => setDialog(false)}>
                  Cancel
                </Button>
                <WriteAction intent="primary" onClick={() => setDialog(false)}>
                  Add 3 members
                </WriteAction>
              </>
            }
          >
            <TextField
              label="People"
              placeholder="Search by name or email…"
              leading={<MagnifyingGlassIcon size={14} />}
            />
          </Dialog>
          <Drawer
            open={drawer}
            onOpenChange={setDrawer}
            eyebrow="User"
            title="Adele Vance"
            description="adele.vance@example.com"
            footer={
              <Button intent="ghost" onClick={() => setDrawer(false)}>
                Close
              </Button>
            }
          >
            <SkeletonText lines={6} />
          </Drawer>
        </div>
      </Panel>
      <Panel eyebrow="Floating" title="Menus, popovers, tooltips and toasts">
        <div className="flex flex-col gap-5">
          <Specimen label="Menu · Popover · Tooltip">
            <Menu>
              <MenuTrigger asChild>
                <Button>
                  Actions
                  <DotsThreeIcon size={16} weight="bold" aria-hidden />
                </Button>
              </MenuTrigger>
              <MenuContent align="start">
                <MenuLabel>User</MenuLabel>
                <MenuItem icon={<CopyIcon size={16} />} shortcut="C">
                  Copy object ID
                </MenuItem>
                <MenuItem icon={<DownloadSimpleIcon size={16} />}>Export sign-ins</MenuItem>
                <MenuCheckboxItem checked>Show disabled users</MenuCheckboxItem>
                <MenuSeparator />
                <MenuItem tone="danger" icon={<TrashIcon size={16} />} disabled>
                  Delete user
                </MenuItem>
              </MenuContent>
            </Menu>
            <Popover>
              <PopoverTrigger asChild>
                <Button>Popover</Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-3">
                <p className="text-sm text-fg-2">Popovers hold small, non-modal controls such as filters.</p>
              </PopoverContent>
            </Popover>
            <Tooltip content="Last synchronised 4 minutes ago">
              <Button intent="ghost">Hover or focus me</Button>
            </Tooltip>
          </Specimen>
          <Specimen label="Toast">
            <Button
              size="sm"
              onClick={() => toast({ tone: 'ok', title: 'Sign-in disabled for adele.vance@example.com' })}
            >
              Success
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast({
                  tone: 'warn',
                  title: 'Write access ends in 5 minutes',
                  action: { label: 'Extend', onClick: () => {} },
                })
              }
            >
              Warning
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast({
                  tone: 'crit',
                  title: 'Microsoft Graph refused this change (403)',
                  description:
                    'Your account has no role that allows disabling users. Activate User Administrator in PIM.',
                })
              }
            >
              Error
            </Button>
            <Button
              size="sm"
              onClick={() =>
                toast({
                  tone: 'info',
                  title: 'Export started',
                  description: 'You’ll get a link when it’s ready.',
                })
              }
            >
              Info
            </Button>
          </Specimen>
        </div>
      </Panel>
    </div>
  );
}

// ── Navigation ───────────────────────────────────────────────────────────────

export function NavigationSection() {
  return (
    <div className={grid2}>
      <Panel eyebrow="Tabs" title="Entity sections">
        <Tabs defaultValue="overview">
          <TabsList aria-label="User sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="groups">Groups</TabsTrigger>
            <TabsTrigger value="devices">Devices</TabsTrigger>
            <TabsTrigger value="signins">Sign-ins</TabsTrigger>
            <TabsTrigger value="audit" disabled>
              Audit
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <p className="text-fg-2">Account, licences, and authentication methods at a glance.</p>
          </TabsContent>
          <TabsContent value="groups">
            <p className="text-fg-2">14 groups, 3 of them dynamic.</p>
          </TabsContent>
          <TabsContent value="devices">
            <p className="text-fg-2">2 devices, both compliant.</p>
          </TabsContent>
          <TabsContent value="signins">
            <p className="text-fg-2">Last sign-in 4 hours ago from Example City.</p>
          </TabsContent>
        </Tabs>
      </Panel>
      <Panel eyebrow="PageHeader" title="Header with breadcrumbs">
        <PageHeader
          className="pb-0"
          breadcrumbs={[
            { label: 'Identity' },
            { label: 'Users', href: '/identity/users' },
            { label: 'Adele Vance' },
          ]}
          linkAs={RouterLink}
          eyebrow="User"
          title="Adele Vance"
          meta={
            <>
              <StatusPill status="ok" size="sm">
                Enabled
              </StatusPill>
              <IdChip value={SAMPLE_GUID} label="Object ID" />
            </>
          }
          description="adele.vance@example.com · Finance"
          actions={<WriteAction size="sm">Disable sign-in</WriteAction>}
        />
      </Panel>
    </div>
  );
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export function FeedbackSection() {
  return (
    <div className={grid3}>
      <Panel eyebrow="Empty" title="EmptyState">
        <EmptyState
          compact
          title="No playbooks in this category yet"
          action={
            <Button size="sm" intent="primary">
              <PlusIcon size={14} aria-hidden />
              New playbook
            </Button>
          }
        >
          Create one with <code className="text-fg">pnpm adminforge new playbook</code>.
        </EmptyState>
      </Panel>
      <Panel eyebrow="Error" title="ErrorState">
        <ErrorState
          compact
          title="Microsoft Graph refused this request (403)"
          message="Your account has no Entra role that can read sign-in logs."
          hint="Activate Reports Reader in PIM, or ask a Portal Admin."
          code="forbidden"
          correlationId={SAMPLE_REQUEST}
        />
      </Panel>
      <Panel eyebrow="Loading" title="Skeleton">
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <Skeleton shape="circle" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="w-2/5" />
              <Skeleton className="h-2.5 w-3/5" />
            </div>
          </div>
          <SkeletonText lines={4} />
          <Skeleton shape="block" className="h-16" />
        </div>
      </Panel>
    </div>
  );
}

// ── Data table ───────────────────────────────────────────────────────────────

const USER_COLUMNS: DataColumn<ShowcaseUser>[] = [
  {
    id: 'name',
    header: 'Name',
    kind: 'identity',
    value: (u) => ({ primary: u.name, secondary: u.upn }),
    hideable: false,
  },
  { id: 'status', header: 'Status', kind: 'status', value: (u) => u.status },
  {
    id: 'type',
    header: 'Type',
    kind: 'text',
    value: (u) => u.type,
    filter: 'facet',
    width: 'minmax(96px, 0.6fr)',
  },
  { id: 'department', header: 'Department', kind: 'text', value: (u) => u.department, filter: 'facet' },
  { id: 'lastSignIn', header: 'Last sign-in', kind: 'relativeTime', value: (u) => u.lastSignIn },
  { id: 'licences', header: 'Licences', kind: 'tags', value: (u) => u.licences },
  { id: 'mfa', header: 'MFA methods', kind: 'number', value: (u) => u.mfa, hidden: true },
  { id: 'id', header: 'Object ID', kind: 'id', value: (u) => u.id },
];

const SMALL_COLUMNS = USER_COLUMNS.filter((c) => ['name', 'status'].includes(c.id)).map((c) => ({
  ...c,
  width: c.id === 'name' ? 'minmax(160px, 2fr)' : 'minmax(110px, 1fr)',
}));
const NO_USERS: ShowcaseUser[] = [];

export function TablesSection() {
  const users = useMemo(() => makeUsers(250), []);
  const navigate = useNavigate();
  const [active, setActive] = useState<string>();
  return (
    <div className="flex flex-col gap-(--af-gap-grid)">
      <Panel
        eyebrow="DataTable"
        title="Users"
        description="250 synthetic users. Sort, filter by facet or column, search, hide columns, select rows (Shift for ranges), and use ↑ ↓ Enter."
        flush
        footer={<ProvenanceFooter service="fixtures" path="/users" ms={42} cachedAt={ago(30_000)} />}
      >
        <DataTable
          label="Users"
          data={users}
          columns={USER_COLUMNS}
          getRowId={(u) => u.id}
          selectable
          rowLabel={(u) => u.name}
          searchPlaceholder="Search name or UPN…"
          activeRowId={active}
          onRowActivate={(u) => {
            setActive(u.id);
            void navigate({
              to: '.',
              search: (prev: Record<string, unknown>) => ({ ...prev, inspect: `user:${u.id}` }),
            });
          }}
          bulkActions={() => (
            <>
              <WriteAction size="sm">Disable sign-in</WriteAction>
              <WriteAction size="sm">Add to group…</WriteAction>
              <Button size="sm" intent="ghost">
                <DownloadSimpleIcon size={14} aria-hidden />
                Export
              </Button>
            </>
          )}
          initialSort={[{ id: 'lastSignIn', desc: true }]}
          maxHeight={480}
        />
      </Panel>
      <div className={grid3}>
        <Panel eyebrow="State" title="Loading" flush>
          <DataTable
            label="Users loading"
            data={NO_USERS}
            columns={SMALL_COLUMNS}
            getRowId={(u) => u.id}
            loading
            toolbar={false}
          />
        </Panel>
        <Panel eyebrow="State" title="Error" flush>
          <DataTable
            label="Sign-in logs"
            data={NO_USERS}
            columns={SMALL_COLUMNS}
            getRowId={(u) => u.id}
            toolbar={false}
            error={{
              message: 'Microsoft Graph is throttling requests from this tenant.',
              hint: 'Try again in 30 seconds.',
              code: 'throttled',
              onRetry: () => {},
            }}
          />
        </Panel>
        <Panel eyebrow="State" title="Empty" flush>
          <DataTable
            label="Guests"
            data={NO_USERS}
            columns={SMALL_COLUMNS}
            getRowId={(u) => u.id}
            toolbar={false}
            empty={{
              title: 'No guests in this tenant',
              description: 'Invite external people from Users → New guest.',
            }}
          />
        </Panel>
      </div>
    </div>
  );
}

// ── Charts ───────────────────────────────────────────────────────────────────

const ms = (v: number) => `${v} ms`;

export function ChartsSection() {
  return (
    <div className={grid2}>
      <Panel
        eyebrow="Line"
        title="Sign-ins per day"
        footer={
          <ProvenanceFooter service="graph" path="/auditLogs/signIns" ms={2310} cachedAt={ago(5 * 60_000)} />
        }
      >
        <Chart
          title="Sign-ins per day"
          kind="line"
          categories={SIGN_INS.categories}
          series={SIGN_INS.series}
          categoryLabel="Day"
        />
      </Panel>
      <Panel
        eyebrow="Bar"
        title="Devices by platform"
        footer={<ProvenanceFooter service="graph" path="/deviceManagement/managedDevices" ms={880} />}
      >
        <Chart
          title="Devices by platform"
          kind="bar"
          categories={DEVICES_BY_OS.categories}
          series={DEVICES_BY_OS.series}
          categoryLabel="Platform"
        />
      </Panel>
      <Panel
        eyebrow="Area"
        title="Upstream latency (p50)"
        className="lg:col-span-2"
        footer={<ProvenanceFooter service="probes" path="/latency" ms={12} cachedAt={ago(60_000)} />}
      >
        <Chart
          title="Upstream latency"
          kind="area"
          categories={GRAPH_LATENCY.categories}
          series={GRAPH_LATENCY.series}
          valueFormat={ms}
          categoryLabel="Day"
          height={220}
        />
      </Panel>
    </div>
  );
}
