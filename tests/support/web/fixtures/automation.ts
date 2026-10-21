import { FIXED_NOW } from './session';

/**
 * Synthetic automation data (Example Org / example.com, generated GUIDs) for the playbook drawer, runs, approvals,
 * runbooks, schedules, synthetic monitoring, audit, appearance and settings. Times are relative to FIXED_NOW so
 * screenshots never drift.
 */

export const at = (msFromNow: number) => new Date(FIXED_NOW + msFromNow).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const ME_UPN = 'mock.engineer@example.com';

export const IDS = {
  aLee: '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d',
  mChen: '7b1d4e2f-8c3a-4f5e-b6d7-1e2f3a4b5c6d',
  jDoe: '9c8b7a6d-5e4f-4321-8a9b-0c1d2e3f4a5b',
  rPatel: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  previewRun: 'a1d0c4f2-1111-4b6e-9c3a-5e7f9a1b3c5d',
  previewRun2: 'a2e1d5a3-1212-4c7f-8d4b-6f8a0b2c4d6e',
  bulkPreview: 'a3f2e6b4-1313-4d8a-9e5c-7a9b1c3d5e7f',
  liveRun: 'b2e1d5a3-2222-4c7f-8d4b-6f8a0b2c4d6e',
  readRun: 'c3f2e6b4-3333-4d8a-9e5c-7a9b1c3d5e7f',
  bulkRun: 'd4a3f7c5-4444-4e9b-8f6d-8b0c2d4e6f8a',
  approvalRun: 'e5b4a8d6-5555-4f0c-9a7e-9c1d3e5f7a9b',
  failedRun: 'f6c5b9e7-6666-4a1d-8b8f-0d2e4f6a8b0c',
  runbookRun: '0a7d6c5b-7777-4b2e-9c9a-1e3f5a7b9c1d',
  runbookPreview: '0b8e7d6c-7878-4c3f-9d0a-2f4a6b8c0d2e',
  tapRun: '1b8e7d6c-8888-4c3f-8d0b-2f4a6b8c0d2e',
  onboardRun: '2c9f8e7d-9999-4d4a-9e1c-3a5b7c9d1e3f',
  onboardChild: '3d0a9f8e-aaaa-4e5b-8f2d-4b6c8d0e2f4a',
  correlation: '5f0c2e81-7a4d-4b39-8c6e-1d2f3a4b5c6d',
  automationApp: '6d5c4b3a-2f1e-4d0c-9b8a-7f6e5d4c3b2a',
  readApp: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
} as const;

// ── Definitions (the client copy GET /api/definitions/:kind/:key returns, plus version + sha256) ──────────────

export const disableUser = {
  kind: 'playbook',
  id: 'identity.disable-user',
  version: '1.0.0',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  title: 'Disable sign-in',
  summary: 'Blocks sign-in and revokes all sessions for one user.',
  owner: 'identity-team',
  risk: 'high',
  mode: 'write',
  requires: {
    portalRoles: ['Portal.Operator'],
    scopes: { graph: ['User.Read.All', 'User.EnableDisableAccount.All', 'User.RevokeSessions.All'] },
    entraRoles: ['User Administrator'],
  },
  confirm: {
    type: 'typed',
    value: '${ steps.lookup.output.userPrincipalName }',
    message: 'Type the user’s sign-in name to confirm.',
  },
  approval: { required: false },
  inputs: {
    userId: { type: 'string', format: 'guid', label: 'User', picker: 'user' },
    reason: { type: 'string', label: 'Reason', minLength: 10, multiline: true },
  },
  steps: [
    {
      id: 'lookup',
      type: 'graph',
      mode: 'read',
      describe: 'Look up the user',
      request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
    },
    {
      id: 'guard',
      type: 'assert',
      name: 'Check the account is enabled',
      that: '${ steps.lookup.output.accountEnabled = true }',
      message: 'Already disabled.',
    },
    {
      id: 'disable',
      type: 'graph',
      mode: 'write',
      describe: 'Set accountEnabled to false',
      request: {
        method: 'PATCH',
        path: '/users/${ $encode(inputs.userId) }',
        body: { accountEnabled: false },
      },
    },
    {
      id: 'revoke',
      type: 'graph',
      mode: 'write',
      describe: 'Revoke refresh tokens and session cookies',
      request: { method: 'POST', path: '/users/${ $encode(inputs.userId) }/revokeSignInSessions' },
    },
  ],
};

export const userSignIns = {
  kind: 'playbook',
  id: 'diagnostics.user-sign-in-check',
  version: '1.2.0',
  sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  title: 'Check a user’s sign-ins',
  summary: 'Reads the last 24 hours of sign-ins for one user and summarises failures by reason.',
  owner: 'identity-team',
  risk: 'low',
  mode: 'read',
  requires: { portalRoles: ['Portal.Reader'], scopes: { graph: ['AuditLog.Read.All', 'User.Read.All'] } },
  inputs: {
    userId: { type: 'string', format: 'guid', label: 'User', picker: 'user' },
    window: {
      type: 'enum',
      label: 'Look back',
      values: [
        { value: 'PT24H', label: 'Last 24 hours' },
        { value: 'P7D', label: 'Last 7 days' },
      ],
      default: 'PT24H',
    },
  },
  steps: [
    {
      id: 'lookup',
      type: 'graph',
      mode: 'read',
      describe: 'Look up the user',
      request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
    },
    {
      id: 'signIns',
      type: 'graph',
      mode: 'read',
      describe: 'Read sign-in logs',
      request: { method: 'GET', path: '/auditLogs/signIns' },
    },
    {
      id: 'summary',
      type: 'transform',
      describe: 'Summarise failures by reason',
      expression: '${ steps.signIns.output }',
    },
  ],
};

export const revokeSessions = {
  kind: 'playbook',
  id: 'identity.revoke-sessions',
  version: '1.0.0',
  sha256: '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae',
  title: 'Revoke sessions',
  summary: 'Signs a user out everywhere by revoking refresh tokens and session cookies.',
  owner: 'identity-team',
  risk: 'medium',
  mode: 'write',
  requires: { portalRoles: ['Portal.Operator'], scopes: { graph: ['User.RevokeSessions.All'] } },
  confirm: { type: 'click' },
  inputs: {
    userId: { type: 'string', format: 'guid', label: 'User', picker: 'user' },
    reason: { type: 'string', label: 'Reason', minLength: 10, multiline: true },
  },
  steps: [
    {
      id: 'revoke',
      type: 'graph',
      mode: 'write',
      describe: 'Revoke refresh tokens and session cookies',
      request: { method: 'POST', path: '/users/${ $encode(inputs.userId) }/revokeSignInSessions' },
    },
  ],
};

export const offboardRunbook = {
  kind: 'runbook',
  id: 'identity.offboard-leaver',
  version: '2.1.0',
  sha256: 'fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9',
  title: 'Offboard a leaver',
  summary:
    'The leaver checklist: block access, hand over mail and files, remove licences, and record what was done.',
  owner: 'identity-team',
  risk: 'high',
  mode: 'write',
  confirm: { type: 'click' },
  inputs: {
    userId: { type: 'string', format: 'guid', label: 'Leaver', picker: 'user' },
    ticket: { type: 'string', label: 'HR ticket', placeholder: 'HR-1234' },
  },
  sections: [
    {
      id: 'confirm',
      title: 'Confirm the request',
      body: 'Check the HR ticket names the **leaver**, their **last day**, and who receives their mail. Don’t start before the last day unless HR says so.',
      steps: [
        {
          id: 'checkTicket',
          type: 'manual',
          name: 'Check the HR ticket',
          instructions: 'Open the ticket and compare the name and last day with the directory.',
          checklist: ['Leaver and last day match the ticket', 'Line manager approved the request'],
        },
      ],
    },
    {
      id: 'block',
      title: 'Block access',
      body: 'Disables sign-in and revokes every session. Runs the **Disable sign-in** playbook.',
      steps: [
        {
          id: 'disable',
          type: 'playbook',
          ref: 'identity.disable-user',
          mode: 'write',
          describe: 'Disable sign-in and revoke sessions',
        },
      ],
    },
    {
      id: 'handover',
      title: 'Hand over mail and files',
      body: '1. Convert the mailbox to a shared mailbox.\n2. Give the line manager access for 30 days.\n3. Move OneDrive files they still need.',
      steps: [
        {
          id: 'mailbox',
          type: 'manual',
          name: 'Convert the mailbox',
          instructions:
            'In Exchange admin, convert the mailbox to **shared** and grant the manager Full Access.',
          checklist: ['Mailbox converted to shared', 'Manager has Full Access'],
        },
      ],
    },
    {
      id: 'licences',
      title: 'Remove licences',
      body: 'Licences are removed once the mailbox is shared, so mail isn’t lost.',
      steps: [
        {
          id: 'removeLicences',
          type: 'graph',
          mode: 'write',
          describe: 'Remove all licences',
          request: { method: 'POST', path: '/users/${ $encode(inputs.userId) }/assignLicense' },
        },
      ],
    },
  ],
};

export const issueTap = {
  kind: 'playbook',
  id: 'identity.issue-tap',
  version: '1.0.0',
  sha256: '4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a',
  title: 'Issue Temporary Access Pass',
  summary: 'Issues a Temporary Access Pass so a user can sign in and register new methods.',
  owner: 'identity-team',
  risk: 'high',
  mode: 'write',
  confirm: { type: 'typed', value: '${ steps.lookup.output.userPrincipalName }' },
  inputs: {
    userId: { type: 'string', format: 'guid', label: 'User', picker: 'user' },
    lifetimeMinutes: {
      type: 'number',
      label: 'Valid for',
      unit: 'minutes',
      default: 60,
      min: 10,
      max: 480,
      integer: true,
    },
  },
  steps: [
    {
      id: 'lookup',
      type: 'graph',
      mode: 'read',
      describe: 'Look up the user',
      request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
    },
    {
      id: 'issue',
      type: 'graph',
      mode: 'write',
      describe: 'Issue the Temporary Access Pass',
      request: {
        method: 'POST',
        path: '/users/${ $encode(inputs.userId) }/authentication/temporaryAccessPassMethods',
      },
    },
  ],
};

/** Synthetic show-once values (never real credentials). */
export const TAP_VALUE = 'Kp4-vR9x-Tq2m-Lz7w';
export const CHILD_TAP_VALUE = 'Hn6-wQ3e-Ys8p-Bd5c';

export const DEFINITIONS: Record<string, unknown> = {
  'playbook:identity.issue-tap': issueTap,
  'playbook:identity.disable-user': disableUser,
  'playbook:diagnostics.user-sign-in-check': userSignIns,
  'playbook:identity.revoke-sessions': revokeSessions,
  'runbook:identity.offboard-leaver': offboardRunbook,
};

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────────

const summary = (o: Record<string, unknown>) => ({
  kind: 'playbook',
  definitionVersion: '1.0.0',
  dryRun: false,
  trigger: 'interactive',
  identity: 'delegated',
  initiatorOid: '0b9e7c2d-41a5-4f68-b3d1-7e2c5a9f0d16',
  initiatorUpn: ME_UPN,
  parentRunId: null,
  scheduleId: null,
  updatedAt: at(0),
  ...o,
});

const step = (seq: number, stepId: string, o: Record<string, unknown>) => ({
  seq,
  stepId,
  path: stepId,
  type: 'graph',
  status: 'succeeded',
  mode: 'read',
  attempt: 1,
  actorOid: null,
  request: null,
  plan: null,
  output: null,
  error: null,
  msRequestId: null,
  startedAt: at(-90_000 + seq * 1000),
  endedAt: at(-89_400 + seq * 1000),
  ...o,
});

const lookupOutput = {
  id: IDS.aLee,
  displayName: 'Adele Lee',
  userPrincipalName: 'a.lee@example.com',
  accountEnabled: true,
};

export const disablePlan = [
  {
    stepId: 'disable',
    stepPath: 'disable',
    describe: 'Set accountEnabled to false',
    service: 'graph',
    method: 'PATCH',
    path: `/users/${IDS.aLee}`,
    body: { accountEnabled: false },
  },
  {
    stepId: 'revoke',
    stepPath: 'revoke',
    describe: 'Revoke refresh tokens and session cookies',
    service: 'graph',
    method: 'POST',
    path: `/users/${IDS.aLee}/revokeSignInSessions`,
  },
];

/** GET /api/runs/:id for the disable-user dry run (preview). */
export function previewDetail(
  inputs: Record<string, unknown> = { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
  { id = IDS.previewRun as string, endedAgoMs = 58_000 } = {},
) {
  return {
    run: {
      ...summary({
        id,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in',
        status: 'succeeded',
        dryRun: true,
        createdAt: at(-endedAgoMs - 2_000),
        startedAt: at(-endedAgoMs - 2_000),
        endedAt: at(-endedAgoMs),
      }),
      definitionSha256: disableUser.sha256,
      correlationId: IDS.correlation,
      inputs,
      outputs: { summary: 'Sign-in disabled and sessions revoked for a.lee@example.com' },
      error: null,
      waiting: null,
      // Rendered by the API from the preview (the person who previewed): what the confirmation dialog shows.
      confirm: {
        type: 'typed',
        value: 'a.lee@example.com',
        message: 'Type the user’s sign-in name to confirm.',
      },
    },
    steps: [
      step(1, 'lookup', { output: lookupOutput }),
      step(2, 'guard', { type: 'assert', output: true }),
      step(3, 'disable', { mode: 'write', status: 'planned', plan: [disablePlan[0]] }),
      step(4, 'revoke', { mode: 'write', status: 'planned', plan: [disablePlan[1]] }),
    ],
    plan: disablePlan,
    tasks: [],
    children: [],
  };
}

/** GET /api/runs/:id for the read playbook run with dryRun: true. */
export function readPreviewDetail() {
  return {
    run: {
      ...summary({
        id: IDS.readRun,
        definitionKey: 'diagnostics.user-sign-in-check',
        definitionVersion: '1.2.0',
        title: 'Check a user’s sign-ins',
        status: 'succeeded',
        dryRun: true,
        createdAt: at(-30_000),
        startedAt: at(-30_000),
        endedAt: at(-27_600),
      }),
      definitionSha256: userSignIns.sha256,
      correlationId: IDS.correlation,
      inputs: { userId: IDS.mChen, window: 'PT24H' },
      outputs: {
        signIns: 46,
        failures: 3,
        topFailure: 'Invalid username or password (50126)',
        lastSuccess: at(-2 * HOUR),
      },
      error: null,
      waiting: null,
    },
    steps: [
      step(1, 'lookup', { output: { id: IDS.mChen, userPrincipalName: 'm.chen@example.com' } }),
      step(2, 'signIns', { output: { count: 46 } }),
      step(3, 'summary', { type: 'transform', output: { failures: 3 } }),
    ],
    plan: [],
    tasks: [],
    children: [],
  };
}

/** The real disable-user run: running when first read, finished once the SSE stream has played. */
export function liveDetail(phase: 'running' | 'done') {
  const done = phase === 'done';
  return {
    run: {
      ...summary({
        id: IDS.liveRun,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in',
        status: done ? 'succeeded' : 'running',
        createdAt: at(-8_000),
        startedAt: at(-8_000),
        endedAt: done ? at(-1_000) : null,
      }),
      definitionSha256: disableUser.sha256,
      correlationId: IDS.correlation,
      inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
      outputs: done ? { summary: 'Sign-in disabled and sessions revoked for a.lee@example.com' } : null,
      error: null,
      waiting: null,
    },
    steps: [
      step(1, 'lookup', { output: lookupOutput, startedAt: at(-8_000), endedAt: at(-7_400) }),
      step(2, 'guard', { type: 'assert', output: true, startedAt: at(-7_400), endedAt: at(-7_300) }),
      step(3, 'disable', {
        mode: 'write',
        status: done ? 'succeeded' : 'running',
        startedAt: at(-7_300),
        endedAt: done ? at(-5_100) : null,
        msRequestId: done ? '8f1c2d3e-0000-4000-8000-00000000abcd' : null,
      }),
      ...(done
        ? [
            step(4, 'revoke', {
              mode: 'write',
              output: { value: true },
              startedAt: at(-5_100),
              endedAt: at(-1_200),
            }),
          ]
        : []),
    ],
    plan: [],
    tasks: [],
    children: [],
  };
}

/** SSE body for the live run: the rest of the run arrives as events (envelope: {id, type, ts, stepSeq, data}). */
export function liveEvents(): string {
  const ev = (id: number, type: string, stepSeq: number | null, data: Record<string, unknown>) =>
    `id: ${id}\ndata: ${JSON.stringify({ id, type, ts: at(-6_000 + id * 400), stepSeq, data })}\n\n`;
  return [
    'retry: 600000\n\n',
    ev(1, 'log', 1, { level: 'info', message: 'GET /users/3f2a…9c1d → 200 (412 ms)', path: 'lookup' }),
    ev(2, 'log', 3, {
      level: 'info',
      message: 'PATCH /users/3f2a…9c1d accountEnabled=false → 204',
      path: 'disable',
    }),
    ev(3, 'step', 3, {
      scope: 'step',
      path: 'disable',
      stepId: 'disable',
      type: 'graph',
      status: 'succeeded',
      attempt: 1,
    }),
    ev(4, 'step', 4, {
      scope: 'step',
      path: 'revoke',
      stepId: 'revoke',
      type: 'graph',
      status: 'running',
      attempt: 1,
    }),
    ev(5, 'log', 4, {
      level: 'warn',
      message: 'Graph throttled once (429); retried after 1 s',
      path: 'revoke',
    }),
    ev(6, 'step', 4, {
      scope: 'step',
      path: 'revoke',
      stepId: 'revoke',
      type: 'graph',
      status: 'succeeded',
      attempt: 1,
    }),
    ev(7, 'run', null, { scope: 'run', status: 'succeeded' }),
    'event: end\ndata: {"status":"succeeded"}\n\n',
  ].join('');
}

/** A bulk run (parent) with three child runs. */
export function bulkDetail() {
  const child = (i: number, upn: string, status: string) =>
    summary({
      id: `d4a3f7c5-4444-4e9b-8f6d-8b0c2d4e6f9${i}`,
      definitionKey: 'identity.revoke-sessions',
      title: `Revoke sessions · ${upn}`,
      status,
      trigger: 'child',
      parentRunId: IDS.bulkRun,
      createdAt: at(-20_000),
      startedAt: at(-20_000),
      endedAt: status === 'running' ? null : at(-15_000),
    });
  return {
    run: {
      ...summary({
        id: IDS.bulkRun,
        definitionKey: 'identity.revoke-sessions',
        title: 'Revoke sessions (bulk)',
        status: 'running',
        trigger: 'bulk',
        createdAt: at(-20_000),
        startedAt: at(-20_000),
        endedAt: null,
      }),
      definitionSha256: revokeSessions.sha256,
      correlationId: IDS.correlation,
      inputs: {
        reason: 'Quarterly leaver sweep',
        items: [{ userId: IDS.aLee }, { userId: IDS.mChen }, { userId: IDS.jDoe }],
      },
      outputs: null,
      error: null,
      waiting: null,
    },
    steps: [step(1, 'items', { type: 'forEach', status: 'running', output: null, endedAt: null })],
    plan: [],
    tasks: [],
    children: [
      child(0, 'a.lee@example.com', 'succeeded'),
      child(1, 'm.chen@example.com', 'succeeded'),
      child(2, 'j.doe@example.com', 'running'),
    ],
  };
}

/** A run parked at an approval gate (requested by someone else), and a failed run with a hint. */
export function approvalRunDetail() {
  return {
    run: {
      ...summary({
        id: IDS.approvalRun,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in',
        status: 'awaiting_approval',
        initiatorUpn: 'r.patel@example.com',
        initiatorOid: IDS.rPatel,
        createdAt: at(-25 * MIN),
        startedAt: at(-25 * MIN),
      }),
      definitionSha256: disableUser.sha256,
      correlationId: IDS.correlation,
      inputs: { userId: IDS.jDoe, reason: 'HR-2231 contractor ended early' },
      outputs: null,
      error: null,
      waiting: { kind: 'approval', path: '$approval', stepId: '$approval', since: at(-24 * MIN) },
    },
    steps: [
      step(1, 'lookup', { output: { userPrincipalName: 'j.doe@example.com', accountEnabled: true } }),
      step(2, 'guard', { type: 'assert', output: true }),
      step(3, '$approval', { type: 'approval', status: 'waiting', endedAt: null }),
    ],
    plan: [],
    tasks: [approvalTask()],
    children: [],
  };
}

export function failedDetail() {
  return {
    run: {
      ...summary({
        id: IDS.failedRun,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in',
        status: 'failed',
        createdAt: at(-3 * HOUR),
        startedAt: at(-3 * HOUR),
        endedAt: at(-3 * HOUR + 4_000),
      }),
      definitionSha256: disableUser.sha256,
      correlationId: IDS.correlation,
      inputs: { userId: IDS.rPatel, reason: 'INC-4790 suspicious sign-ins' },
      outputs: null,
      error: {
        code: 'Authorization_RequestDenied',
        message: 'Microsoft Graph refused this change (403).',
        hint: 'Your account has no Entra role that allows disabling this user. Activate User Administrator in PIM, or ask a Portal Admin.',
        stepId: 'disable',
        status: 403,
        requestId: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
      },
      waiting: null,
    },
    steps: [
      step(1, 'lookup', { output: { userPrincipalName: 'r.patel@example.com', accountEnabled: true } }),
      step(2, 'guard', { type: 'assert', output: true }),
      step(3, 'disable', {
        mode: 'write',
        status: 'failed',
        output: null,
        error: {
          code: 'Authorization_RequestDenied',
          message: 'Insufficient privileges to complete the operation.',
          status: 403,
          hint: 'Activate User Administrator in PIM, then run it again.',
        },
      }),
    ],
    plan: [],
    tasks: [],
    children: [],
  };
}

export function approvalTask() {
  return {
    id: '7c6b5a49-8888-4c3d-9e2f-1a0b9c8d7e6f',
    subjectType: 'run',
    subjectId: IDS.approvalRun,
    stepId: '$approval',
    kind: 'approval',
    title: 'Disable sign-in',
    status: 'pending',
    requestedBy: 'r.patel@example.com',
    requestedByOid: IDS.rPatel,
    createdAt: at(-24 * MIN),
    expiresAt: at(3 * HOUR + 36 * MIN),
    decidedAt: null,
    policy: {
      kind: 'approval',
      path: '$approval',
      stepId: '$approval',
      message: 'Disabling **j.doe@example.com** (contractor). HR ticket HR-2231 — contract ended early.',
      approvers: ['Playbook.Approver'],
      minApprovals: 1,
      expiresAt: at(3 * HOUR + 36 * MIN),
      title: 'Disable sign-in',
      definitionKey: 'identity.disable-user',
      definitionVersion: '1.0.0',
      requestedByUpn: 'r.patel@example.com',
      writesAfter: true,
    },
    decisions: [],
    canDecide: true,
  };
}

export function runsList() {
  return {
    items: [
      summary({
        id: IDS.liveRun,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in',
        status: 'running',
        createdAt: at(-8_000),
        startedAt: at(-8_000),
        endedAt: null,
      }),
      summary({
        id: IDS.approvalRun,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in',
        status: 'awaiting_approval',
        initiatorUpn: 'r.patel@example.com',
        createdAt: at(-25 * MIN),
        startedAt: at(-25 * MIN),
        endedAt: null,
      }),
      summary({
        id: IDS.bulkRun,
        definitionKey: 'identity.revoke-sessions',
        title: 'Revoke sessions (bulk)',
        status: 'running',
        trigger: 'bulk',
        createdAt: at(-20_000),
        startedAt: at(-20_000),
        endedAt: null,
      }),
      summary({
        id: IDS.previewRun,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in',
        status: 'succeeded',
        dryRun: true,
        createdAt: at(-60_000),
        startedAt: at(-60_000),
        endedAt: at(-58_000),
      }),
      summary({
        id: IDS.readRun,
        definitionKey: 'diagnostics.user-sign-in-check',
        title: 'Check a user’s sign-ins',
        status: 'succeeded',
        createdAt: at(-42 * MIN),
        startedAt: at(-42 * MIN),
        endedAt: at(-42 * MIN + 2_400),
      }),
      summary({
        id: IDS.failedRun,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in',
        status: 'failed',
        createdAt: at(-3 * HOUR),
        startedAt: at(-3 * HOUR),
        endedAt: at(-3 * HOUR + 4_000),
      }),
      summary({
        id: IDS.runbookRun,
        kind: 'runbook',
        definitionKey: 'identity.offboard-leaver',
        definitionVersion: '2.1.0',
        title: 'Offboard a leaver',
        status: 'awaiting_input',
        createdAt: at(-26 * HOUR),
        startedAt: at(-26 * HOUR),
        endedAt: null,
      }),
      summary({
        id: '1b2c3d4e-9999-4f5a-8b6c-7d8e9f0a1b2c',
        definitionKey: 'reports.app-credential-expiry',
        title: 'Weekly app credential expiry report',
        status: 'succeeded',
        identity: 'automation',
        trigger: 'schedule',
        initiatorUpn: null,
        createdAt: at(-2 * DAY - 7 * HOUR),
        startedAt: at(-2 * DAY - 7 * HOUR),
        endedAt: at(-2 * DAY - 7 * HOUR + 38_000),
      }),
      summary({
        id: '2c3d4e5f-aaaa-4a6b-9c7d-8e9f0a1b2c3d',
        definitionKey: 'identity.revoke-sessions',
        title: 'Revoke sessions',
        status: 'compensated',
        createdAt: at(-3 * DAY),
        startedAt: at(-3 * DAY),
        endedAt: at(-3 * DAY + 9_000),
      }),
      summary({
        id: '3d4e5f6a-bbbb-4b7c-8d8e-9f0a1b2c3d4e',
        definitionKey: 'identity.reset-mfa',
        title: 'Reset MFA methods',
        status: 'cancelled',
        createdAt: at(-4 * DAY),
        startedAt: at(-4 * DAY),
        endedAt: at(-4 * DAY + 61_000),
      }),
    ],
  };
}

/**
 * GET /api/runs/:id for the leaver runbook's dry run (preview): its reads ran, its checklists were skipped, its writes
 * (the child playbooks) are planned, and the API rendered the runbook's confirmation from it.
 */
export function runbookPreviewDetail(
  inputs: Record<string, unknown> = { userId: IDS.jDoe, ticket: 'HR-2231' },
) {
  return {
    run: {
      ...summary({
        id: IDS.runbookPreview,
        kind: 'runbook',
        definitionKey: 'identity.offboard-leaver',
        definitionVersion: '2.1.0',
        title: 'Offboard a leaver',
        status: 'succeeded',
        dryRun: true,
        createdAt: at(-60_000),
        startedAt: at(-60_000),
        endedAt: at(-58_000),
      }),
      definitionSha256: offboardRunbook.sha256,
      correlationId: IDS.correlation,
      inputs,
      outputs: null,
      error: null,
      waiting: null,
      confirm: {
        type: 'click',
        value: null,
        message: 'Start the leaver process for j.doe@example.com (HR-2231)?',
      },
    },
    steps: [
      step(1, 'checkTicket', { type: 'manual', status: 'skipped', output: { dryRun: true } }),
      step(2, 'disable', { type: 'playbook', mode: 'write', status: 'planned', plan: [leaverPlan[0]] }),
      step(3, 'mailbox', { type: 'manual', status: 'skipped', output: { dryRun: true } }),
      step(4, 'removeLicences', { mode: 'write', status: 'planned', plan: [leaverPlan[1]] }),
    ],
    plan: leaverPlan,
    tasks: [],
    children: [],
  };
}

const leaverPlan = [
  {
    stepId: 'disable',
    stepPath: 'disable',
    describe: 'Disable sign-in and revoke sessions',
    service: 'playbook',
    method: 'RUN',
    path: 'identity.disable-user',
  },
  {
    stepId: 'removeLicences',
    stepPath: 'removeLicences',
    describe: 'Remove all licences',
    service: 'graph',
    method: 'POST',
    path: `/users/${IDS.jDoe}/assignLicense`,
  },
];

/** The runbook run, parked on the mailbox checklist (two sections done). */
export function runbookRunDetail() {
  return {
    run: {
      ...summary({
        id: IDS.runbookRun,
        kind: 'runbook',
        definitionKey: 'identity.offboard-leaver',
        definitionVersion: '2.1.0',
        title: 'Offboard a leaver',
        status: 'awaiting_input',
        createdAt: at(-26 * HOUR),
        startedAt: at(-26 * HOUR),
      }),
      definitionSha256: offboardRunbook.sha256,
      correlationId: IDS.correlation,
      inputs: { userId: IDS.jDoe, ticket: 'HR-2231' },
      outputs: null,
      error: null,
      waiting: { kind: 'manual', path: 'mailbox', stepId: 'mailbox', since: at(-25 * HOUR) },
    },
    steps: [
      step(1, 'checkTicket', { type: 'manual', startedAt: at(-26 * HOUR), endedAt: at(-25.9 * HOUR) }),
      step(2, 'disable', {
        type: 'playbook',
        mode: 'write',
        output: { runId: IDS.liveRun, status: 'succeeded' },
        startedAt: at(-25.9 * HOUR),
        endedAt: at(-25.5 * HOUR),
      }),
      step(3, 'mailbox', { type: 'manual', status: 'waiting', startedAt: at(-25 * HOUR), endedAt: null }),
    ],
    plan: [],
    tasks: [
      {
        id: '8d7c6b5a-cccc-4d3e-8f2a-1b0c9d8e7f6a',
        subjectType: 'run',
        subjectId: IDS.runbookRun,
        stepId: 'mailbox',
        kind: 'manual',
        title: 'Offboard a leaver',
        status: 'pending',
        requestedBy: ME_UPN,
        createdAt: at(-25 * HOUR),
        expiresAt: null,
        policy: {
          kind: 'manual',
          path: 'mailbox',
          stepId: 'mailbox',
          instructions:
            'In Exchange admin, convert the mailbox to **shared** and grant the manager Full Access.',
          checklist: ['Mailbox converted to shared', 'Manager has Full Access'],
          title: 'Offboard a leaver',
        },
        decisions: [],
        canDecide: true,
      },
    ],
    children: [],
  };
}

// ── Capabilities and search ────────────────────────────────────────────────────────────────────────────────

export const capabilities = {
  roles: {
    active: [
      {
        roleDefinitionId: '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b',
        displayName: 'Helpdesk Administrator',
        directoryScopeId: '/',
      },
    ],
    eligible: [
      {
        roleDefinitionId: '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c',
        displayName: 'User Administrator',
        directoryScopeId: '/',
      },
    ],
    activeSource: 'pim',
  },
  features: {},
  skus: [{ skuPartNumber: 'SPE_E5', capabilityStatus: 'Enabled', enabled: 2500, consumed: 2412 }],
};

export const PEOPLE = [
  {
    type: 'user',
    id: IDS.aLee,
    title: 'Adele Lee',
    subtitle: 'a.lee@example.com',
    href: `/p/identity.user?id=${IDS.aLee}`,
  },
  {
    type: 'user',
    id: IDS.mChen,
    title: 'Ming Chen',
    subtitle: 'm.chen@example.com',
    href: `/p/identity.user?id=${IDS.mChen}`,
  },
  {
    type: 'user',
    id: IDS.jDoe,
    title: 'Jordan Doe',
    subtitle: 'j.doe@example.com',
    href: `/p/identity.user?id=${IDS.jDoe}`,
  },
  {
    type: 'user',
    id: IDS.rPatel,
    title: 'Riya Patel',
    subtitle: 'r.patel@example.com',
    href: `/p/identity.user?id=${IDS.rPatel}`,
  },
];

export function searchResults(q: string, type: string | null) {
  const needle = q.toLowerCase();
  return {
    query: q,
    results: PEOPLE.filter(
      (p) =>
        (!type || p.type === type) &&
        (p.title.toLowerCase().includes(needle) || p.subtitle.includes(needle) || p.id === needle),
    ),
    sources: { definitions: 'skipped', directory: 'ok', azure: 'skipped' },
  };
}

// ── Schedules and probes ───────────────────────────────────────────────────────────────────────────────────

export function schedules() {
  return {
    items: [
      {
        key: 'reports.app-credential-expiry',
        title: 'Weekly app credential expiry report',
        summary: 'Every Monday at 07:00 UTC, writes the 30-day app credential expiry report as XLSX.',
        cron: '0 7 * * 1',
        cronText: null,
        timezone: 'UTC',
        enabled: true,
        identity: 'automation',
        job: { kind: 'report', ref: 'identity.app-credential-expiry' },
        nextRunAt: at(3 * DAY + 17 * HOUR),
        lastRunAt: at(-2 * DAY - 7 * HOUR),
        lastStatus: 'succeeded',
        writeCapable: false,
        source: 'content',
      },
      {
        key: 'probes.graph-reachability',
        title: 'Microsoft Graph reachability',
        summary: 'Reads the organization object every 5 minutes and measures latency.',
        cron: '*/5 * * * *',
        cronText: null,
        timezone: 'UTC',
        enabled: true,
        // A named app identity (ADR-014), so the list's "Runs as" column shows both kinds.
        identity: 'app:monitoring',
        runsAs: { kind: 'app', name: 'monitoring', label: 'app identity monitoring' },
        job: { kind: 'probe', ref: 'probes.graph-reachability' },
        nextRunAt: at(3 * MIN),
        lastRunAt: at(-2 * MIN),
        lastStatus: 'succeeded',
        writeCapable: false,
        source: 'content',
      },
      {
        key: 'maintenance.content-health',
        title: 'Content health',
        summary:
          'Re-validates published definitions against the schemas and the automation identity’s permissions.',
        cron: '0 6 * * *',
        cronText: null,
        timezone: 'Europe/London',
        enabled: true,
        identity: 'automation',
        job: { kind: 'contentHealth', ref: null },
        nextRunAt: at(15 * HOUR),
        lastRunAt: at(-9 * HOUR),
        lastStatus: 'failed',
        writeCapable: false,
        source: 'content',
      },
      {
        key: 'identity.disable-stale-guests',
        title: 'Disable stale guest accounts',
        summary: 'Disables guests with no sign-in for 90 days (write: needs two-person approval).',
        cron: '0 2 * * 1-5',
        cronText: null,
        timezone: 'UTC',
        enabled: false,
        identity: 'automation',
        job: { kind: 'playbook', ref: 'identity.disable-stale-guests' },
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
        writeCapable: true,
        approvedBy: [],
        source: 'content',
      },
      {
        key: 'reports.licence-usage-monthly',
        title: 'Monthly licence usage',
        summary: 'First of the month: licence seats by SKU, emailed to the service desk.',
        cron: '0 8 1 * *',
        cronText: null,
        timezone: 'UTC',
        enabled: false,
        identity: 'automation',
        job: { kind: 'report', ref: 'm365.licence-usage' },
        nextRunAt: null,
        lastRunAt: at(-45 * DAY),
        lastStatus: 'succeeded',
        writeCapable: false,
        source: 'portal',
      },
    ],
  };
}

export function scheduleRuns(key: string) {
  if (key === 'maintenance.content-health')
    return {
      items: [
        {
          id: 'sr-ch-3',
          trigger: 'cron',
          status: 'failed',
          startedAt: at(-9 * HOUR),
          endedAt: at(-9 * HOUR + 12_000),
          error: {
            message:
              '2 definitions need permissions the automation identity lacks: Reports.Read.All, AuditLog.Read.All.',
            code: 'scope_missing',
          },
        },
        {
          id: 'sr-ch-2',
          trigger: 'cron',
          status: 'succeeded',
          startedAt: at(-33 * HOUR),
          endedAt: at(-33 * HOUR + 10_000),
        },
        {
          id: 'sr-ch-1',
          trigger: 'manual',
          status: 'succeeded',
          startedAt: at(-50 * HOUR),
          endedAt: at(-50 * HOUR + 9_000),
        },
      ],
    };
  return {
    items: [
      {
        id: 'sr-1',
        trigger: 'cron',
        status: 'succeeded',
        startedAt: at(-2 * DAY - 7 * HOUR),
        endedAt: at(-2 * DAY - 7 * HOUR + 38_000),
        runId: '1b2c3d4e-9999-4f5a-8b6c-7d8e9f0a1b2c',
        artifact: {
          name: 'app-credential-expiry-2026-10-12.xlsx',
          href: '/api/schedules/reports.app-credential-expiry/artifacts/sr-1',
          size: 48_211,
        },
      },
      {
        id: 'sr-2',
        trigger: 'cron',
        status: 'failed',
        startedAt: at(-9 * DAY - 7 * HOUR),
        endedAt: at(-9 * DAY - 7 * HOUR + 30_000),
        error: {
          message: 'Microsoft Graph throttled the request (429) after 3 retries.',
          code: 'graph_throttled',
        },
      },
      {
        id: 'sr-3',
        trigger: 'manual',
        status: 'succeeded',
        startedAt: at(-10 * DAY),
        endedAt: at(-10 * DAY + 41_000),
        artifact: {
          name: 'app-credential-expiry-2026-10-05.xlsx',
          href: '/api/schedules/reports.app-credential-expiry/artifacts/sr-3',
          size: 47_002,
        },
      },
      {
        id: 'sr-4',
        trigger: 'cron',
        status: 'succeeded',
        startedAt: at(-16 * DAY - 7 * HOUR),
        endedAt: at(-16 * DAY - 7 * HOUR + 36_000),
        artifact: {
          name: 'app-credential-expiry-2026-09-28.xlsx',
          href: '/api/schedules/reports.app-credential-expiry/artifacts/sr-4',
          size: 46_550,
        },
      },
    ],
  };
}

/** Deterministic pseudo-random series around a base value (no Math.random: screenshots stay stable). */
function series(base: number, spread: number, n: number, status: (v: number, i: number) => string) {
  return Array.from({ length: n }, (_, i) => {
    const wobble = Math.sin(i * 1.7) * 0.5 + Math.cos(i * 0.6) * 0.5;
    const metric = Math.round((base + wobble * spread) * 10) / 10;
    return { ts: at(-(n - 1 - i) * 30 * MIN), metric, status: status(metric, i) };
  });
}

/** The service each mock probe watches (a probe's `group`). */
const GROUP_OF: Record<string, string> = {
  'probes.graph-reachability': 'm365',
  'probes.arm-reachability': 'azure',
  'probes.token-graph': 'platform',
  'probes.token-exchange': 'exchange',
  'probes.portal-readiness': 'platform',
  'probes.portal-tls-certificate': 'platform',
  'probes.app-credential-expiry': 'identity',
  'probes.sign-in-health': 'identity',
  'probes.licence-seats-spe-e5': 'm365',
  'probes.dns-mx': 'exchange',
  'probes.function-hr-sync-health': 'azure',
  'probes.exchange-mail-flow': 'exchange',
  'probes.exchange-autodiscover-service': 'exchange',
  'probes.sharepoint-file-round-trip': 'sharepoint',
  'probes.sharepoint-service-incidents': 'sharepoint',
  'probes.teams-online-meeting': 'teams',
  'probes.teams-sign-ins': 'teams',
  'probes.entra-home-realm-discovery': 'identity',
};

/** GET /api/probes `groups`: the services in navigation order, then AdminForge itself. */
export const PROBE_GROUPS = [
  { key: 'identity', label: 'Identity', icon: 'identification-card' },
  { key: 'm365', label: 'Microsoft 365', icon: 'squares-four' },
  { key: 'exchange', label: 'Exchange Online', icon: 'envelope-simple' },
  { key: 'sharepoint', label: 'SharePoint Online', icon: 'globe-hemisphere-west' },
  { key: 'teams', label: 'Teams', icon: 'microsoft-teams-logo' },
  { key: 'azure', label: 'Azure', icon: 'cloud' },
  { key: 'platform', label: 'AdminForge', icon: 'gauge' },
];

export function probes() {
  const lat = (warn: number, crit: number) => (v: number) => (v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok');
  const mk = (
    key: string,
    title: string,
    kind: string,
    base: number,
    spread: number,
    t: { warn: number; crit: number; unit: string },
    override?: Partial<{ status: string; message: string; metric: number }>,
  ) => {
    const s = series(base, spread, 24, lat(t.warn, t.crit));
    const last = s[s.length - 1]!;
    const latest = { ...last, unit: t.unit, message: null as string | null, ...override };
    if (override?.metric !== undefined || override?.status)
      s[s.length - 1] = { ...last, metric: latest.metric, status: latest.status };
    return {
      key,
      title,
      kind,
      group: GROUP_OF[key] ?? null,
      latest,
      series: s,
      thresholds: { warn: t.warn, crit: t.crit },
    };
  };
  const days = (warn: number, crit: number) => (v: number) =>
    v <= crit ? 'crit' : v <= warn ? 'warn' : 'ok';
  return {
    items: [
      mk('probes.graph-reachability', 'Microsoft Graph reachability', 'graph', 410, 120, {
        warn: 1500,
        crit: 5000,
        unit: 'ms',
      }),
      mk('probes.arm-reachability', 'Azure Resource Manager reachability', 'arm', 620, 180, {
        warn: 2000,
        crit: 6000,
        unit: 'ms',
      }),
      mk('probes.token-graph', 'Token: Microsoft Graph', 'tokenAcquisition', 180, 40, {
        warn: 1000,
        crit: 3000,
        unit: 'ms',
      }),
      mk(
        'probes.token-exchange',
        'Token: Exchange Online',
        'tokenAcquisition',
        1650,
        300,
        { warn: 1000, crit: 3000, unit: 'ms' },
        { status: 'warn', metric: 1840, message: 'Slower than usual: 1,840 ms (warn at 1,000 ms).' },
      ),
      mk('probes.portal-readiness', 'AdminForge readiness', 'http', 95, 20, {
        warn: 800,
        crit: 3000,
        unit: 'ms',
      }),
      {
        key: 'probes.portal-tls-certificate',
        title: 'Portal TLS certificate',
        kind: 'certExpiry',
        group: 'platform',
        latest: {
          ts: at(-40 * MIN),
          metric: 12,
          status: 'warn',
          unit: 'days',
          message: 'Certificate for portal.example.com expires in 12 days.',
        },
        series: Array.from({ length: 12 }, (_, i) => ({
          ts: at(-(11 - i) * DAY),
          metric: 23 - i,
          status: days(30, 7)(23 - i),
        })),
        thresholds: { warn: 30, crit: 7 },
      },
      {
        key: 'probes.app-credential-expiry',
        title: 'App credentials expiring',
        kind: 'appCredentialExpiry',
        group: 'identity',
        latest: {
          ts: at(-3 * HOUR),
          metric: 3,
          status: 'crit',
          unit: 'days',
          message: 'HR sync client secret expires in 3 days.',
        },
        series: Array.from({ length: 12 }, (_, i) => ({
          ts: at(-(11 - i) * DAY),
          metric: 14 - i,
          status: days(30, 7)(14 - i),
        })),
        thresholds: { warn: 30, crit: 7 },
      },
      mk('probes.sign-in-health', 'Sign-in failure rate', 'signInHealth', 2.4, 0.8, {
        warn: 5,
        crit: 10,
        unit: '%',
      }),
      mk(
        'probes.licence-seats-spe-e5',
        'Licence seats: Microsoft 365 E5',
        'licenseThreshold',
        96.5,
        0.4,
        { warn: 90, crit: 98, unit: '%' },
        { status: 'warn', metric: 96.5, message: '2,412 of 2,500 seats assigned (96.5%).' },
      ),
      mk('probes.dns-mx', 'DNS: MX for example.com', 'dnsResolve', 24, 6, {
        warn: 500,
        crit: 2000,
        unit: 'ms',
      }),
      {
        key: 'probes.function-hr-sync-health',
        title: 'Function app: HR sync',
        kind: 'functionHealth',
        group: 'azure',
        latest: null,
        series: [],
        thresholds: { warn: 2000, crit: 8000 },
      },
      mk('probes.exchange-mail-flow', 'Mail flow — end-to-end delivery', 'mailFlow', 7.5, 2.5, {
        warn: 30,
        crit: 75,
        unit: 's',
      }),
      mk(
        'probes.exchange-autodiscover-service',
        'Exchange Autodiscover for the mail domain',
        'http',
        520,
        140,
        {
          warn: 2000,
          crit: 6000,
          unit: 'ms',
        },
      ),
      mk(
        'probes.sharepoint-file-round-trip',
        'SharePoint files — upload, download, delete',
        'fileRoundTrip',
        2100,
        600,
        { warn: 5000, crit: 15000, unit: 'ms' },
        {
          status: 'warn',
          metric: 6240,
          message:
            'Uploaded, downloaded and deleted a 16 KB file in 6240 ms (upload 4410 ms, download 1290 ms, delete 540 ms).',
        },
      ),
      mk(
        'probes.sharepoint-service-incidents',
        'SharePoint Online without an open incident',
        'graphCount',
        0,
        0,
        {
          warn: 1,
          crit: 1,
          unit: 'items',
        },
      ),
      mk('probes.teams-online-meeting', 'Teams meetings — create and delete', 'onlineMeeting', 1300, 300, {
        warn: 4000,
        crit: 10000,
        unit: 'ms',
      }),
      mk('probes.teams-sign-ins', 'Microsoft Teams sign-in failure rate', 'signInHealth', 3.1, 1.2, {
        warn: 15,
        crit: 30,
        unit: '%',
      }),
      mk('probes.entra-home-realm-discovery', 'Entra ID sign-in — realm discovery', 'http', 160, 40, {
        warn: 1000,
        crit: 4000,
        unit: 'ms',
      }),
    ],
    groups: PROBE_GROUPS,
  };
}

// ── Audit, appearance, settings ────────────────────────────────────────────────────────────────────────────

export function auditEvents() {
  const ev = (seq: number, ago: number, o: Record<string, unknown>) => ({
    seq,
    ts: at(-ago),
    actorUpn: ME_UPN,
    actorOid: '0b9e7c2d-41a5-4f68-b3d1-7e2c5a9f0d16',
    mode: 'read',
    targetType: null,
    targetId: null,
    result: 'success',
    correlationId: `5f0c2e81-7a4d-4b39-8c6e-${String(seq).padStart(12, '0')}`,
    details: null,
    ...o,
  });
  return {
    items: [
      ev(12408, 40_000, {
        action: 'run.step.write',
        mode: 'write',
        targetType: 'run',
        targetId: IDS.liveRun,
        details: {
          step: 'revoke',
          method: 'POST',
          path: `/users/${IDS.aLee}/revokeSignInSessions`,
          status: 204,
          requestId: '8f1c2d3e-0000-4000-8000-00000000abce',
        },
      }),
      ev(12407, 45_000, {
        action: 'run.step.write',
        mode: 'write',
        targetType: 'run',
        targetId: IDS.liveRun,
        details: {
          step: 'disable',
          method: 'PATCH',
          path: `/users/${IDS.aLee}`,
          body: { accountEnabled: false },
          status: 204,
        },
      }),
      ev(12406, 50_000, {
        action: 'run.created',
        mode: 'write',
        targetType: 'run',
        targetId: IDS.liveRun,
        details: {
          definition: 'identity.disable-user',
          version: '1.0.0',
          dryRun: false,
          risk: 'high',
          inputs: { userId: IDS.aLee, reason: 'INC-4821 account compromised' },
        },
      }),
      ev(12405, 3 * MIN, {
        action: 'session.armed',
        mode: 'write',
        details: { minutes: 60, reason: 'INC-4821 account compromised' },
      }),
      ev(12404, 4 * MIN, {
        action: 'run.created',
        targetType: 'run',
        targetId: IDS.previewRun,
        details: { definition: 'identity.disable-user', dryRun: true },
      }),
      ev(12403, 25 * MIN, {
        action: 'run.created',
        actorUpn: 'r.patel@example.com',
        mode: 'write',
        targetType: 'run',
        targetId: IDS.approvalRun,
        details: { definition: 'identity.disable-user', dryRun: false },
      }),
      ev(12402, 42 * MIN, {
        action: 'run.completed',
        targetType: 'run',
        targetId: IDS.readRun,
        details: { status: 'succeeded' },
      }),
      ev(12401, 2 * HOUR, {
        action: 'appearance.updated',
        actorUpn: 'portal.admin@example.com',
        targetType: 'settings',
        targetId: 'appearance',
        details: { version: 3, themes: ['steel'], overrides: { steel: { accent: '#8FB4F0' } } },
      }),
      ev(12400, 3 * HOUR, {
        action: 'run.step.write',
        mode: 'write',
        targetType: 'run',
        targetId: IDS.failedRun,
        result: 'failure',
        details: { step: 'disable', method: 'PATCH', status: 403, error: 'Authorization_RequestDenied' },
      }),
      ev(12399, 3 * HOUR + MIN, {
        action: 'deny',
        actorUpn: 'guest.reader@example.com',
        result: 'denied',
        details: { reason: 'Portal.Operator required to arm' },
      }),
      ev(12398, 5 * HOUR, { action: 'session.signin', details: { authMode: 'mock' } }),
      ev(12397, 26 * HOUR, {
        action: 'appearance.updated',
        actorUpn: 'portal.admin@example.com',
        targetType: 'settings',
        targetId: 'appearance',
        details: { version: 2, themes: [], overrides: {}, density: 'compact' },
      }),
      ev(12396, 2 * DAY, {
        action: 'report.exported',
        targetType: 'report',
        targetId: 'identity.app-credential-expiry',
        details: { format: 'xlsx', rows: 214 },
      }),
    ],
    cursor: '12396',
  };
}

export function auditEventsOlder() {
  return {
    items: [
      {
        seq: 12395,
        ts: at(-3 * DAY),
        actorUpn: ME_UPN,
        actorOid: null,
        mode: 'read',
        action: 'session.signout',
        targetType: null,
        targetId: null,
        result: 'success',
        correlationId: '5f0c2e81-7a4d-4b39-8c6e-000000012395',
        details: null,
      },
    ],
  };
}

export const auditVerify = { ok: true, checked: 12408 };

export function appearance() {
  return { version: 3, overrides: { steel: { accent: '#8FB4F0' } } };
}

export function settings() {
  return {
    authMode: 'mock',
    dataMode: 'fixtures',
    contentSource: 'fs',
    writeSessionMaxMinutes: 60,
    writeStepUp: 'freshSignIn',
    auditChain: { keyed: false },
    apps: { read: true, write: true, automation: false },
    tenant: { name: 'Example Org', domain: 'example.com' },
  };
}

// ── Show-once secrets ──────────────────────────────────────────────────────────────────────────────────────

const tapMask = { $secret: true, hint: 'one-time use · valid 60 min' };

/** The TAP run: finished; the pass is masked in stored outputs and arrives once on the live stream. */
export function tapDetail() {
  return {
    run: {
      ...summary({
        id: IDS.tapRun,
        definitionKey: 'identity.issue-tap',
        title: 'Issue Temporary Access Pass',
        status: 'succeeded',
        createdAt: at(-20_000),
        startedAt: at(-20_000),
        endedAt: at(-17_000),
      }),
      definitionSha256: issueTap.sha256,
      correlationId: IDS.correlation,
      inputs: { userId: IDS.mChen, lifetimeMinutes: 60 },
      outputs: {
        summary: 'Temporary Access Pass issued for m.chen@example.com',
        temporaryAccessPass: tapMask,
      },
      error: null,
      waiting: null,
    },
    steps: [
      step(1, 'lookup', {
        output: { userPrincipalName: 'm.chen@example.com' },
        startedAt: at(-20_000),
        endedAt: at(-19_400),
      }),
      step(2, 'issue', {
        mode: 'write',
        output: { temporaryAccessPass: tapMask, lifetimeInMinutes: 60, isUsableOnce: true },
        startedAt: at(-19_400),
        endedAt: at(-17_200),
      }),
    ],
    plan: [],
    tasks: [],
    children: [],
  };
}

/** The live secret message: no `id:` line, never replayed. */
export function secretMessage(runId: string = IDS.tapRun, value = TAP_VALUE) {
  return {
    type: 'secret',
    runId,
    stepId: 'issue',
    stepPath: 'issue',
    values: { temporaryAccessPass: value },
    hints: { temporaryAccessPass: 'One-time use · valid for 60 minutes' },
    producedAt: at(-17_200),
  };
}

export function tapEvents(): string {
  const ev = (id: number, type: string, stepSeq: number | null, data: Record<string, unknown>) =>
    `id: ${id}\ndata: ${JSON.stringify({ id, type, ts: at(-19_000 + id * 300), stepSeq, data })}\n\n`;
  return [
    'retry: 600000\n\n',
    ev(1, 'log', 2, { level: 'info', message: 'POST temporaryAccessPassMethods → 201', path: 'issue' }),
    `data: ${JSON.stringify(secretMessage())}\n\n`,
    ev(2, 'log', 2, {
      level: 'info',
      message: 'Temporary Access Pass issued (shown once)',
      path: 'issue',
      secret: {
        runId: IDS.tapRun,
        stepId: 'issue',
        stepPath: 'issue',
        fields: ['temporaryAccessPass'],
        status: 'delivered',
      },
    }),
    'event: end\ndata: {"status":"succeeded"}\n\n',
  ].join('');
}

/** A parent run (onboarding) whose child issued a TAP while nobody watched: the replay says it is held. */
export function onboardDetail() {
  return {
    run: {
      ...summary({
        id: IDS.onboardRun,
        definitionKey: 'identity.onboard-user',
        title: 'Onboard a new starter',
        status: 'succeeded',
        createdAt: at(-5 * MIN),
        startedAt: at(-5 * MIN),
        endedAt: at(-4 * MIN),
      }),
      definitionSha256: issueTap.sha256,
      correlationId: IDS.correlation,
      inputs: { displayName: 'Sam Okafor', department: 'Finance' },
      outputs: { summary: 'Account created and a Temporary Access Pass issued.' },
      error: null,
      waiting: null,
    },
    steps: [
      step(1, 'create', { mode: 'write', output: { id: IDS.rPatel } }),
      step(2, 'tap', {
        type: 'playbook',
        mode: 'write',
        output: { runId: IDS.onboardChild, status: 'succeeded' },
      }),
    ],
    plan: [],
    tasks: [],
    children: [
      summary({
        id: IDS.onboardChild,
        definitionKey: 'identity.issue-tap',
        title: 'Issue Temporary Access Pass',
        status: 'succeeded',
        trigger: 'child',
        parentRunId: IDS.onboardRun,
        createdAt: at(-4.5 * MIN),
        endedAt: at(-4 * MIN),
      }),
    ],
  };
}

export function onboardEvents(): string {
  return [
    'retry: 600000\n\n',
    `id: 1\ndata: ${JSON.stringify({ id: 1, type: 'log', ts: at(-4 * MIN), stepSeq: 2, data: { level: 'info', message: 'Temporary Access Pass issued for the new starter (held for the requester)', path: 'tap', secret: { runId: IDS.onboardChild, stepId: 'issue', stepPath: 'issue', fields: ['temporaryAccessPass'], status: 'held' } } })}\n\n`,
    'event: end\ndata: {"status":"succeeded"}\n\n',
  ].join('');
}

/** A bulk dry run (disable-user × 2): each item is its own planned child run. */
export function bulkPreviewDetail() {
  const child = (i: number, upn: string, status = 'succeeded') =>
    summary({
      id: `a3f2e6b4-1313-4d8a-9e5c-7a9b1c3d5e8${i}`,
      definitionKey: 'identity.disable-user',
      title: `Disable sign-in · ${upn}`,
      status,
      dryRun: true,
      trigger: 'child',
      parentRunId: IDS.bulkPreview,
      createdAt: at(-30_000),
      endedAt: at(-28_000),
    });
  return {
    run: {
      ...summary({
        id: IDS.bulkPreview,
        definitionKey: 'identity.disable-user',
        title: 'Disable sign-in (bulk)',
        status: 'succeeded',
        dryRun: true,
        trigger: 'bulk',
        createdAt: at(-30_000),
        startedAt: at(-30_000),
        endedAt: at(-28_000),
      }),
      definitionSha256: disableUser.sha256,
      correlationId: IDS.correlation,
      inputs: { reason: 'Leaver sweep HR-2240', items: [{ userId: IDS.aLee }, { userId: IDS.mChen }] },
      outputs: null,
      error: null,
      waiting: null,
    },
    steps: [step(1, 'items', { type: 'forEach', mode: 'write' })],
    plan: [
      { ...disablePlan[0], stepPath: 'items[0].run', childRunId: 'a3f2e6b4-1313-4d8a-9e5c-7a9b1c3d5e80' },
      {
        ...disablePlan[1],
        stepPath: 'items[0].run#revoke',
        childRunId: 'a3f2e6b4-1313-4d8a-9e5c-7a9b1c3d5e80',
      },
      {
        ...disablePlan[0],
        path: `/users/${IDS.mChen}`,
        stepPath: 'items[1].run',
        childRunId: 'a3f2e6b4-1313-4d8a-9e5c-7a9b1c3d5e81',
      },
      {
        ...disablePlan[1],
        path: `/users/${IDS.mChen}/revokeSignInSessions`,
        stepPath: 'items[1].run#revoke',
        childRunId: 'a3f2e6b4-1313-4d8a-9e5c-7a9b1c3d5e81',
      },
    ],
    tasks: [],
    children: [child(0, 'a.lee@example.com'), child(1, 'm.chen@example.com')],
  };
}

/**
 * A portal report schedule that runs with its creator's own access (ADR-014), in a given sign-in state, and a handler
 * that adds it to GET /api/schedules (its history is empty) and answers POST /auth/schedule-consent.
 */
export const CREATOR_SCHEDULE_KEY = 'portal.inactive-guests-me';
export function creatorSchedule(signIn: 'signed_in' | 'needs_sign_in' | 'not_signed_in', canSignIn = true) {
  return {
    key: CREATOR_SCHEDULE_KEY,
    title: 'Inactive guests, with my access',
    summary: null,
    cron: '0 6 * * 1',
    cronText: null,
    timezone: 'UTC',
    enabled: true,
    identity: 'user',
    runsAs: {
      kind: 'user',
      name: 'avery@example.com',
      label: 'avery@example.com (their own access)',
      signIn,
      canSignIn,
    },
    job: { kind: 'report', ref: 'identity.inactive-guests' },
    nextRunAt: at(3 * DAY),
    // Never ran before its creator signed in; after Microsoft asked for a new sign-in, its last run was skipped.
    lastRunAt: signIn === 'not_signed_in' ? null : at(-4 * DAY),
    lastStatus: signIn === 'needs_sign_in' ? 'skipped' : signIn === 'signed_in' ? 'succeeded' : null,
    writeCapable: false,
    source: 'portal',
    createdBy: 'avery@example.com',
    canManage: canSignIn,
    delivery: [{ type: 'file', format: 'xlsx', retain: 26 }],
    notify: [],
  };
}
export function creatorScheduleHandler(
  signIn: 'signed_in' | 'needs_sign_in' | 'not_signed_in',
  canSignIn = true,
) {
  const consents: Array<{ url: string; body: unknown }> = [];
  const handler = ({
    method,
    path,
    url,
    body,
  }: {
    method: string;
    path: string;
    url: URL;
    body?: unknown;
  }) => {
    if (method === 'GET' && path === '/api/schedules')
      return { body: { items: [creatorSchedule(signIn, canSignIn), ...schedules().items] } };
    if (method === 'GET' && path === `/api/schedules/${CREATOR_SCHEDULE_KEY}/runs`)
      return {
        body: {
          items:
            signIn === 'needs_sign_in'
              ? [
                  {
                    id: 'sr-me-1',
                    trigger: 'cron',
                    status: 'skipped',
                    startedAt: at(-4 * DAY),
                    endedAt: at(-4 * DAY),
                    error: {
                      code: 'needs_sign_in',
                      message:
                        'This schedule runs with avery@example.com’s own access, and Microsoft needs them to sign in again, so it didn’t run.',
                    },
                    reason:
                      'This schedule runs with avery@example.com’s own access, and Microsoft needs them to sign in again, so it didn’t run.',
                  },
                ]
              : [],
          cursor: null,
        },
      };
    if (method === 'POST' && path === '/auth/schedule-consent') {
      consents.push({ url: `${url.pathname}${url.search}`, body });
      return { body: { redirect: 'https://login.example.com/authorize?mock=1' } };
    }
    return undefined;
  };
  return { handler, consents };
}
