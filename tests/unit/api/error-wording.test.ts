import { BulkRunBody } from '@adminforge/api/src/routes/runs';
import { MockStateRequest } from '@adminforge/api/src/auth/mock-routes';
import { AppError, errorBody, parseBody, toAppError } from '@adminforge/api/src/errors';
import { QueryRequest } from '@adminforge/api/src/query/service';
import { ArmRequest, ExportRequest, UserPrefs } from '@adminforge/schemas';

// F-13: error bodies are written for the person in front of the browser — a plain message, a hint where they can
// act, always the code and the reference. zod's own wording ("Invalid option: expected one of "csv"|"xlsx"") and
// Fastify's codes and texts (`ctp_body_too_large`, "…content-type is set to 'application/json'") never reach them.
// The schemas are the API's own request bodies.

const refused = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (err) {
    return err as AppError;
  }
  throw new Error('expected a refusal');
};
const message = (schema: Parameters<typeof parseBody>[0], body: unknown) =>
  refused(() => parseBody(schema, body)).message;
const GUID = '00000000-0000-4000-8000-000000000001';

describe('parseBody wording', () => {
  it('names the field and the accepted options in plain words, with a hint', () => {
    const err = refused(() => parseBody(ExportRequest, { params: {}, format: 'pdf', version: '1.0.0' }));
    expect(err).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(err.message).toBe('The request isn’t valid: format must be csv or xlsx.');
    expect(err.extras.hint).toMatch(/^Correct/);
  });

  it.each([
    [{ reason: 'Because' }, 'minutes is missing'],
    [{ minutes: 'ten', reason: 'Because' }, 'minutes must be a number'],
    [{ minutes: 2.5, reason: 'Because' }, 'minutes must be a whole number'],
    [{ minutes: 1, reason: 'Because' }, 'minutes must be at least 5'],
    [{ minutes: 999, reason: 'Because' }, 'minutes must be at most 480'],
    [{ minutes: 30, reason: 'x' }, 'reason must be at least 5 characters'],
    [{ minutes: 30, reason: 7 }, 'reason must be text'],
  ])('arm %j → "%s"', (body, phrase) => {
    expect(message(ArmRequest, body)).toBe(`The request isn’t valid: ${phrase}.`);
  });

  it.each([
    [{ playbook: 'test.p', items: [] }, 'items needs at least one item'],
    [{ playbook: 'test.p', items: [{}], dryRun: 'yes' }, 'dryRun must be true or false'],
    [{ playbook: 'test.p', items: [{}], concurrency: 0 }, 'concurrency must be at least 1'],
  ])('bulk run %j → "%s"', (body, phrase) => {
    expect(message(BulkRunBody, body)).toBe(`The request isn’t valid: ${phrase}.`);
  });

  it('says a missing choice is missing, with the choices', () => {
    expect(message(ExportRequest, { params: {}, version: '1.0.0' })).toBe(
      'The request isn’t valid: format is missing (csv or xlsx).',
    );
  });

  it('lists the accepted values of a list item, and names the item', () => {
    expect(message(MockStateRequest, { roles: ['Not.A.Role'] })).toMatch(
      /^The request isn’t valid: roles\[0\] must be one of Portal\.Reader, Portal\.Operator, .+\.$/,
    );
  });

  it('says which field is not accepted', () => {
    expect(message(UserPrefs.strict(), { unknownKey: 1 })).toBe(
      'The request isn’t valid: unknownKey isn’t accepted.',
    );
    expect(message(UserPrefs.strict(), { a: 1, b: 2 })).toBe(
      'The request isn’t valid: a, b aren’t accepted.',
    );
  });

  it('keeps a message the schema wrote itself, after the field', () => {
    expect(
      message(QueryRequest, { source: 'resourceGraph', query: 'resources', subscriptions: ['nope'] }),
    ).toBe('The request isn’t valid: subscriptions[0]: Expected a GUID.');
    expect(message(QueryRequest, { source: 'resourceGraph', query: 'resources', workspace: GUID })).toBe(
      'The request isn’t valid: workspace: workspace applies to logAnalytics only.',
    );
  });

  it('says what the whole body should be', () => {
    expect(message(ArmRequest, 'text')).toBe('The request isn’t valid: the body must be an object.');
  });

  it('lists at most three problems, then says how many more', () => {
    expect(
      message(UserPrefs.strict(), { a: 1, theme: 9, density: 9, navCollapsed: 'x', pinned: 'x' }),
    ).toMatch(/^The request isn’t valid: [^;]+; [^;]+; [^;]+, and 2 more\.$/);
  });

  it('never shows zod’s own wording', () => {
    for (const body of [{ format: 'pdf' }, { format: 3 }, {}, 'text', [1], { params: 'x', version: 3 }]) {
      const text = message(ExportRequest, body);
      expect(text).not.toMatch(/Invalid (option|input|string)|expected one of|Too (small|big)|"\|"|received/);
    }
  });

  it('passes valid bodies through untouched', () => {
    expect(parseBody(ArmRequest, { minutes: 30, reason: 'Disable a user' })).toEqual({
      minutes: 30,
      reason: 'Disable a user',
    });
  });
});

describe('Fastify errors become ours', () => {
  const fastifyError = (code: string, statusCode: number, message: string) =>
    Object.assign(new Error(message), { code, statusCode });

  it('a body over the limit is 413 body_too_large with a hint', () => {
    const err = toAppError(fastifyError('FST_ERR_CTP_BODY_TOO_LARGE', 413, 'Request body is too large'));
    expect(err).toMatchObject({ status: 413, code: 'body_too_large' });
    expect(err.message).toMatch(/larger than AdminForge accepts/);
    expect(err.extras.hint).toMatch(/less at once/i);
  });

  it.each([
    [
      'FST_ERR_CTP_INVALID_JSON_BODY',
      400,
      "Body is not valid JSON but content-type is set to 'application/json'",
    ],
    [
      'FST_ERR_CTP_EMPTY_JSON_BODY',
      400,
      "Body cannot be empty when content-type is set to 'application/json'",
    ],
    ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', 400, 'Request body size did not match Content-Length'],
  ])('%s is a plain invalid_request, without header names', (code, status, message) => {
    const err = toAppError(fastifyError(code, status, message));
    expect(err).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(err.message).not.toMatch(/content-type|content-length|JSON/i);
    expect(err.extras.hint).toBeTruthy();
  });

  it('an unsupported body format is 415 unsupported_media_type', () => {
    const err = toAppError(fastifyError('FST_ERR_CTP_INVALID_MEDIA_TYPE', 415, 'Unsupported Media Type'));
    expect(err).toMatchObject({ status: 415, code: 'unsupported_media_type' });
    expect(err.extras.hint).toBeTruthy();
  });

  it('other Fastify 4xx keep their status with a plain message and hint, never Fastify’s text', () => {
    const err = toAppError(fastifyError('FST_ERR_BAD_URL', 400, "'%zz' is not a valid url component"));
    expect(err).toMatchObject({ status: 400, code: 'bad_url' });
    expect(err.message).not.toContain('url component');
    expect(err.extras.hint).toBeTruthy();
  });
});

describe('error bodies', () => {
  it.each([
    ['not_found', 404, /address|navigation/i],
    ['invalid_cursor', 400, /reload/i],
    ['run_not_found', 404, /Runs/],
    ['datasource_not_found', 404, /reload/i],
    ['invalid_request', 400, /reload|correct/i],
    ['body_too_large', 413, /less at once/i],
  ])('%s gets a hint where the thrower gave none', (code, status, hint) => {
    const body = errorBody(new AppError(status, code, 'Something happened.'), 'ref-1');
    expect(body.error).toMatchObject({ code, message: 'Something happened.', correlationId: 'ref-1' });
    expect(body.error.hint).toMatch(hint);
  });

  it('keeps the thrower’s own hint and extras, and adds none to codes without a default', () => {
    expect(
      errorBody(new AppError(404, 'not_found', 'Gone.', { hint: 'Open it from Runs.' }), 'r').error.hint,
    ).toBe('Open it from Runs.');
    const plain = errorBody(new AppError(409, 'conflict', 'Changed meanwhile.', { detail: 'x' }), 'r');
    expect(plain.error).toEqual({
      code: 'conflict',
      message: 'Changed meanwhile.',
      detail: 'x',
      correlationId: 'r',
    });
  });
});
