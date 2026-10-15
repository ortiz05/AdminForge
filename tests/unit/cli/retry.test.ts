import { ApiError } from '@adminforge/connectors';
import { isReplicationDelay, withReplicationRetry } from '@adminforge/cli/src/provision/retry';

const noSleep = async () => {};

describe('isReplicationDelay', () => {
  it.each([
    [new ApiError(404, 'Request_ResourceNotFound', 'gone'), true],
    [new ApiError(400, 'PrincipalNotFound', 'Principal x does not exist in the directory'), true],
    [new ApiError(400, 'Request_BadRequest', "The appId 'x' of the service principal does not reference a valid application object."), true],
    [new ApiError(400, 'Request_BadRequest', 'Invalid object identifier'), true],
    [new ApiError(400, 'Request_BadRequest', 'Property displayName is too long'), false],
    [new ApiError(403, 'Authorization_RequestDenied', 'Insufficient privileges'), false],
    [new Error('boom'), false],
  ])('%s → %s', (err, expected) => expect(isReplicationDelay(err)).toBe(expected));
});

describe('withReplicationRetry', () => {
  it('retries replication errors with backoff, then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const result = await withReplicationRetry(
      async () => {
        if (++n < 3) throw new ApiError(404, 'Request_ResourceNotFound', 'not yet');
        return 'ok';
      },
      { sleep: noSleep, baseMs: 100, onRetry: (_e, _a, ms) => waits.push(ms) },
    );
    expect(result).toBe('ok');
    expect(waits).toEqual([100, 200]);
  });

  it('does not retry other errors', async () => {
    let n = 0;
    await expect(
      withReplicationRetry(async () => {
        n++;
        throw new ApiError(403, 'Forbidden', 'no');
      }, { sleep: noSleep }),
    ).rejects.toThrow('no');
    expect(n).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    let n = 0;
    await expect(
      withReplicationRetry(async () => {
        n++;
        throw new ApiError(404, 'Request_ResourceNotFound', 'never');
      }, { sleep: noSleep, attempts: 3 }),
    ).rejects.toThrow('never');
    expect(n).toBe(3);
  });
});
