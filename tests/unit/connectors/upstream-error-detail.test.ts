import { createHttpClient } from '@adminforge/connectors';

// Microsoft's specific cause (a KQL syntax error, an ARM field detail) reaches the person, not just the generic outer
// message ("The request had some invalid properties").
const client = (body: unknown, status = 400) =>
  createHttpClient({
    getToken: async () => 't',
    maxRetries: 0,
    fetch: async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  });

describe('upstream error messages', () => {
  it('appends the innermost Log Analytics innererror', async () => {
    const body = {
      error: {
        code: 'BadArgumentError',
        message: 'The request had some invalid properties',
        innererror: {
          code: 'SyntaxError',
          message: 'A recognition error occurred in the query.',
          innererror: { code: 'SYN0002', message: "Query could not be parsed at 'whre' on line [1,15]" },
        },
      },
    };
    await expect(
      client(body).send({ url: 'https://api.loganalytics.io/v1/x', method: 'POST' }),
    ).rejects.toMatchObject({
      code: 'BadArgumentError',
      message: "The request had some invalid properties: Query could not be parsed at 'whre' on line [1,15]",
    });
  });

  it('uses the first ARM detail', async () => {
    const body = {
      error: {
        code: 'InvalidRequestContent',
        message: 'The request content was invalid.',
        details: [{ code: 'x', message: 'Tag name "owner" is required.' }],
      },
    };
    await expect(
      client(body).send({ url: 'https://management.azure.com/x', method: 'PUT' }),
    ).rejects.toMatchObject({
      message: 'The request content was invalid: Tag name "owner" is required.',
    });
  });

  it('leaves Graph errors (no innererror message) unchanged', async () => {
    const body = {
      error: {
        code: 'Authorization_RequestDenied',
        message: 'Insufficient privileges to complete the operation.',
        innerError: { date: 'x', 'request-id': 'r' },
      },
    };
    await expect(
      client(body, 403).send({ url: 'https://graph.microsoft.com/v1.0/x', method: 'GET' }),
    ).rejects.toMatchObject({
      message: 'Insufficient privileges to complete the operation.',
    });
  });
});
