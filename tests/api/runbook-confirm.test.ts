import { mockConfig } from './helpers';
import { AVERY, FakeExecutor, runsApp, StaticDefinitions } from './runs-helpers';

// Runbooks with a `confirm` block (identity.leaver, identity.compromised-account, azure.new-subscription-onboarding)
// follow "preview then confirm" like playbooks: starting one without a preview is refused (what the runbook page used
// to send), and a preview renders the confirmation the runbook page shows before it starts the run.
const USER = '00000000-0000-4000-8000-000000000001';
const OPERATOR = ['Portal.Reader', 'Portal.Operator'];

const leaver = {
  kind: 'runbook',
  id: 'test.leaver',
  version: '1.0.0',
  title: 'Leaver',
  owner: 'tests',
  risk: 'high',
  mode: 'write',
  inputs: { userId: { type: 'string', format: 'guid' }, ticket: { type: 'string' } },
  confirm: {
    type: 'click',
    message:
      "${ 'Start the leaver process for ' & steps.account.output.userPrincipalName & ' (' & inputs.ticket & ')?' }",
  },
  sections: [
    {
      id: 'check',
      title: 'Check',
      steps: [
        {
          id: 'account',
          type: 'graph',
          mode: 'read',
          request: { method: 'GET', path: '/users/${ $encode(inputs.userId) }' },
        },
        { id: 'ticketOk', type: 'manual', instructions: 'Check the HR ticket.' },
        {
          id: 'disable',
          type: 'graph',
          mode: 'write',
          describe: 'Disable sign-in',
          request: {
            method: 'PATCH',
            path: '/users/${ $encode(inputs.userId) }',
            body: { accountEnabled: false },
          },
        },
      ],
    },
  ],
};

describe('runbooks with a confirm block: preview, then confirm', () => {
  it('starting without a preview is refused; a preview renders the confirmation; with it the runbook starts', async () => {
    const outbound = new FakeExecutor((c) =>
      c.method === 'GET' ? { userPrincipalName: 'j.doe@example.com' } : null,
    );
    const t = await runsApp({
      config: mockConfig(),
      definitions: new StaticDefinitions().add(leaver as never),
      outbound,
    });
    try {
      const avery = await t.login(AVERY, OPERATOR);
      const inputs = { userId: USER, ticket: 'HR-2231' };
      const bare = await avery.post('/api/runs', {
        playbook: 'test.leaver',
        version: '1.0.0',
        inputs,
        dryRun: false,
      });
      expect(bare.statusCode).toBe(409);
      expect(bare.json().error).toMatchObject({ code: 'preview_required' });

      const preview = (
        await avery.post('/api/runs', { playbook: 'test.leaver', version: '1.0.0', inputs, dryRun: true })
      ).json() as { runId: string };
      await t.drain();
      const shown = (await avery.get(`/api/runs/${preview.runId}`)).json();
      expect(shown.run).toMatchObject({
        status: 'succeeded',
        kind: 'runbook',
        confirm: {
          type: 'click',
          value: null,
          message: 'Start the leaver process for j.doe@example.com (HR-2231)?',
        },
      });
      expect(shown.plan.map((p: { stepId: string }) => p.stepId)).toEqual(['disable']);

      const started = await avery.post('/api/runs', {
        playbook: 'test.leaver',
        version: '1.0.0',
        inputs,
        dryRun: false,
        previewRunId: preview.runId,
      });
      expect(started.statusCode).toBe(202);
      await t.drain();
      const run = (await avery.get(`/api/runs/${started.json().runId}`)).json().run;
      expect(run).toMatchObject({ kind: 'runbook', dryRun: false, status: 'awaiting_input' });
      expect(outbound.calls.filter((c) => c.call.method !== 'GET')).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
