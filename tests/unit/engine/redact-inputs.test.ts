import { harness, playbook } from './helpers';

// Values of inputs declared `redact: true` never reach stored step requests, plans, outputs, errors or events
// (and from there the run view and the audit log). The step itself still receives the real value.
const SECRET = 'Pa55-phrase-for-the-vendor-API';

const def = () =>
  playbook(
    [
      {
        id: 'set',
        type: 'graph',
        mode: 'write',
        describe: 'Store the passphrase',
        request: {
          method: 'PATCH',
          path: '/users/u',
          body: { note: 'value=${ inputs.passphrase }' },
        },
      },
    ],
    { inputs: { passphrase: { type: 'string', redact: true } } },
  );

describe('redact: true inputs', () => {
  it('are masked in what is stored and emitted, but sent for real', async () => {
    const h = harness(def(), {
      inputs: { passphrase: SECRET },
      respond: () => ({ echoed: `got ${SECRET}` }),
    });
    await h.exec();
    expect((await h.run()).status).toBe('succeeded');
    // The call went out with the real value.
    expect(JSON.stringify(h.outbound.calls)).toContain(SECRET);
    // Nothing persisted or emitted contains it.
    const stored = JSON.stringify(await h.all());
    expect(stored).not.toContain(SECRET);
    expect(stored).toContain('[redacted]');
    expect(JSON.stringify(h.store.events)).not.toContain(SECRET);
  });

  it('leaves runs without redacted inputs untouched', async () => {
    const h = harness(
      playbook([{ id: 'r', type: 'graph', mode: 'read', request: { method: 'GET', path: '/me' } }]),
      {
        respond: () => ({ token: 'not-a-secret-input' }),
      },
    );
    await h.exec();
    expect(JSON.stringify(await h.all())).toContain('not-a-secret-input');
  });
});
