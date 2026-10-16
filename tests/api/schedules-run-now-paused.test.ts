import { ApiErrorBody } from '@adminforge/schemas';
import { AVERY, BLAKE, FakeDefinitions, FakeJobs, schedule, schedulesApp } from './schedules-helpers';

// Emergency stop (ENG-08): while automation is paused, Run now is refused up front with the reason, instead of
// answering "started" and skipping the run afterwards.
describe('Run now while automation is paused', () => {
  it('is refused with 409 automation_paused and queues nothing; works again once resumed', async () => {
    const defs = new FakeDefinitions().set(
      schedule('sweep.every-15-minutes', { job: { kind: 'probe', select: { tags: ['sweep-15m'] } } }),
    );
    const t = await schedulesApp({ defs, jobs: new FakeJobs(() => ({ result: {} })), inProcess: true });
    const admin = await t.login(AVERY, ['Portal.Reader', 'Portal.Operator', 'Portal.Admin']);
    const op = await t.login(BLAKE, ['Portal.Reader', 'Portal.Operator']);
    const pause = (paused: boolean) =>
      t.app.inject({
        method: 'PUT',
        url: '/api/admin/emergency',
        headers: admin.headers,
        payload: { target: 'automation', paused, reason: 'Investigating a schedule' },
      });
    expect((await pause(true)).statusCode).toBe(200);

    const res = await op.post('/api/schedules/sweep.every-15-minutes/run');
    expect(res.statusCode).toBe(409);
    expect(ApiErrorBody.parse(res.json()).error).toMatchObject({
      code: 'automation_paused',
      message: 'An administrator has paused automation, so schedules can’t run now.',
      hint: expect.stringContaining('Audit'),
    });
    expect((await op.get('/api/schedules/sweep.every-15-minutes/runs')).json().items).toEqual([]);

    expect((await pause(false)).statusCode).toBe(200);
    expect((await op.post('/api/schedules/sweep.every-15-minutes/run')).statusCode).toBe(202);
    await t.close();
  });
});
