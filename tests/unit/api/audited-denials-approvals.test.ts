import { MemoryAuditWriter } from '@adminforge/api/src/audit/writer';
import { AppError, AUDITED_DENIALS, DenialAudit } from '@adminforge/api/src/errors';

// S-12: separation-of-duties refusals in approvals are security-relevant, like `own_run` and `own_request`: an
// approver trying to approve a change that grants them access (`own_access`), or someone completing a step that waits
// for another engineer (`not_your_step`), leaves a `request.denied` event in the audit log.

const SESSION = {
  idHash: 'a'.repeat(64),
  userOid: '00000000-0000-4000-8000-0000000000a1',
  upn: 'avery@example.com',
  writeExpiresAt: null,
};

/** The parts of a Fastify request DenialAudit reads. */
const request = (url: string) =>
  ({
    id: 'ref-1',
    ip: '127.0.0.1',
    method: 'POST',
    url,
    routeOptions: { url: '/api/runs/:id/approvals/:stepId' },
    session: SESSION,
  }) as never;

describe('audited denials in approvals', () => {
  it.each(['own_access', 'not_your_step'])('%s is an audited denial', (code) => {
    expect(AUDITED_DENIALS.has(code)).toBe(true);
  });

  it('keeps the other separation-of-duties refusals audited', () => {
    for (const code of ['own_run', 'own_request', 'forbidden', 'csrf', 'policy_denied'])
      expect(AUDITED_DENIALS.has(code)).toBe(true);
  });

  it.each([
    ['own_access', "This change grants you access, so you can't approve it."],
    [
      'not_your_step',
      'Only the engineer this step is waiting for can confirm it: the steps after it run as them.',
    ],
  ])(
    'a %s refusal leaves a request.denied event with the route, code and status only',
    async (code, message) => {
      const audit = new MemoryAuditWriter(() => new Date('2026-10-21T08:00:00Z'));
      const denials = new DenialAudit({ audit, now: () => new Date('2026-10-21T08:00:00Z') });
      await denials.record(
        request('/api/runs/00000000-0000-4000-8000-000000000001/approvals/grant'),
        new AppError(403, code, message, { hint: 'Ask another approver.' }),
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        action: 'request.denied',
        actorOid: SESSION.userOid,
        actorUpn: SESSION.upn,
        targetType: 'route',
        targetId: 'POST /api/runs/:id/approvals/:stepId',
        result: 'denied',
        details: { code, status: 403 },
        correlationId: 'ref-1',
      });
      // Nothing from the request or the message is kept: the run id stays in the route pattern only.
      expect(JSON.stringify(audit.rows[0])).not.toMatch(/000000000001|grants you access|waiting for/);
    },
  );

  it('ordinary mistakes in approvals stay unaudited', async () => {
    const audit = new MemoryAuditWriter();
    const denials = new DenialAudit({ audit, now: () => new Date() });
    for (const code of ['run_not_found', 'approval_not_found', 'run_finished', 'invalid_request'])
      await denials.record(request('/api/approvals/x'), new AppError(404, code, 'No such run.'));
    expect(audit.rows).toHaveLength(0);
  });
});
