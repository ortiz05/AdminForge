import { ApiError } from '@adminforge/connectors';
import { StepError, toRunError } from '@adminforge/engine';

// A failed run tells the person what to do (activate a PIM role, licence missing…), not just Microsoft's message.
class HintedError extends ApiError {
  constructor(readonly hint: string) {
    super(403, 'Authorization_RequestDenied', 'Insufficient privileges to complete the operation.', 'req-1');
  }
}

describe('toRunError keeps the next step', () => {
  it('from an upstream error that carries one (OutboundError)', () => {
    expect(
      toRunError(new HintedError('Activate User Administrator in PIM, then run it again.')),
    ).toMatchObject({
      code: 'Authorization_RequestDenied',
      message: 'Insufficient privileges to complete the operation.',
      hint: 'Activate User Administrator in PIM, then run it again.',
      requestId: 'req-1',
    });
  });

  it('from a StepError, separate from the message', () => {
    expect(
      toRunError(new StepError('forbidden', 'Running X needs Portal.Operator.', { hint: 'Ask an admin.' })),
    ).toEqual({
      code: 'forbidden',
      message: 'Running X needs Portal.Operator.',
      hint: 'Ask an admin.',
    });
  });
});
