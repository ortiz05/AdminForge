import { EventEmitter } from 'node:events';
import { clientSignal } from '@adminforge/api/src/routes/datasources';

// A page left while it loads stops calling Microsoft: the datasource routes abort when the connection closes before
// the answer was sent, and only then.

const reply = (finished: boolean) => {
  const raw = Object.assign(new EventEmitter(), { writableFinished: finished });
  return { raw } as never;
};

describe('clientSignal', () => {
  it('aborts (499 client_closed) when the browser goes away before the answer', () => {
    const r = reply(false);
    const signal = clientSignal(r);
    expect(signal.aborted).toBe(false);
    (r as { raw: EventEmitter }).raw.emit('close');
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ status: 499, code: 'client_closed' });
  });

  it('stays quiet once the answer was sent', () => {
    const r = reply(true);
    const signal = clientSignal(r);
    (r as { raw: EventEmitter }).raw.emit('close');
    expect(signal.aborted).toBe(false);
  });
});
