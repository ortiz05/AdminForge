import { ENVELOPE, errors, ok, yaml } from './helpers';

// A gate that can be stepped over is no gate: an approval with `onError: continue` let a rejected (or expired, or
// unworkable) approval through to the writes after it. Validate refuses it; the engine stops the run either way.
const head = `${ENVELOPE('playbook', 'identity.example')}risk: low\nmode: write\n`;
const write =
  '{ id: w, type: graph, mode: write, describe: Write, request: { method: PATCH, path: /me, body: {} } }';

describe('approval steps', () => {
  it('refuses onError: continue on an approval', () => {
    const errs = errors(
      head +
        yaml`
        steps:
          - { id: approve, type: approval, onError: continue }
          - ${write}
        `,
    );
    expect(errs.map((e) => [e.path, e.message])).toContainEqual([
      'steps[0].onError',
      'An approval that is rejected, expires or can’t be worked out stops the run: onError: continue is not allowed on an approval.',
    ]);
  });

  it('accepts fail and compensate', () => {
    for (const onError of ['fail', 'compensate'])
      ok(
        head +
          yaml`
          steps:
            - { id: approve, type: approval, onError: ${onError} }
            - ${write}
          `,
      );
  });
});
