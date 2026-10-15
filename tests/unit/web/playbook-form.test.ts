import type { Params } from '@adminforge/schemas';
import {
  humanize,
  initialValues,
  prefillFromSearch,
  previewMatches,
  stableJson,
  validateForm,
} from '@adminforge/web/src/playbooks/form';
import { decodeParam, encodeParam } from '@adminforge/web/src/playbooks/url';

const params = {
  userId: { type: 'string', format: 'guid', label: 'User', picker: 'user' },
  revokeSessions: { type: 'boolean', label: 'Also sign the user out everywhere', default: true },
  reason: { type: 'string', label: 'Reason', minLength: 10, multiline: true },
} as unknown as Params;

describe('playbook form helpers', () => {
  it('starts from literal defaults, overlaid with link inputs; unknown keys are reported', () => {
    expect(initialValues(params, { userId: 'abc', ticket: 'HR-1' })).toEqual({
      values: { userId: 'abc', revokeSessions: true },
      unknown: ['ticket'],
    });
    expect(initialValues(params, {}, ['userId']).values).toEqual({ revokeSessions: true });
  });

  it('validates with zod and returns submit-ready values', () => {
    expect(validateForm(params, { userId: 'nope', reason: 'short' })).toEqual({
      ok: false,
      values: {},
      errors: { userId: 'Expected a GUID.', reason: 'Must be at least 10 characters.' },
    });
    expect(
      validateForm(params, {
        userId: '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d',
        revokeSessions: false,
        reason: 'INC-4821 compromised',
      }),
    ).toEqual({
      ok: true,
      values: {
        userId: '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d',
        revokeSessions: false,
        reason: 'INC-4821 compromised',
      },
      errors: {},
    });
  });

  it('a preview matches the form when every sent input ran with the same value', () => {
    const sent = { userId: '3F2A8C1E-5B7D-4E19-9A6C-2D8E4F1B9C1D', minutes: '60' };
    expect(
      previewMatches(sent, {
        userId: '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d',
        minutes: 60,
        addedByServer: true,
      }),
    ).toBe(true);
    expect(previewMatches(sent, { userId: '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d', minutes: 30 })).toBe(false);
  });

  it('stableJson ignores key order; humanize labels keys', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(humanize('lifetimeMinutes')).toBe('Lifetime minutes');
    expect(humanize('user_id')).toBe('User id');
  });
});

describe('prefillFromSearch (runbook links)', () => {
  const rb = {
    userId: { type: 'string', format: 'guid', label: 'Leaver', picker: 'user' },
    ticket: { type: 'string', label: 'HR ticket' },
    hours: { type: 'number', label: 'Hours', min: 1, max: 72 },
    members: { type: 'user', multiple: true },
  } as unknown as Params;
  const guid = '9c8b7a6d-5e4f-4321-8a9b-0c1d2e3f4a5b';

  it('reads plain params named like inputs, and base64url inputs (plain params win)', () => {
    const r = prefillFromSearch(
      rb,
      { userId: guid, ticket: 2231, inputs: encodeParam({ ticket: 'HR-1', hours: 8 }) },
      decodeParam,
    );
    expect(r).toEqual({ values: { userId: guid, ticket: '2231', hours: 8 }, problems: [] });
  });

  it('drops values that fail the input schema and says why; ignores unrelated params', () => {
    const r = prefillFromSearch(
      rb,
      { userId: 'not-a-guid', hours: 500, members: `a@example.com, ${guid}`, inspect: 'user:1' },
      decodeParam,
    );
    expect(r.values).toEqual({ members: ['a@example.com', guid] });
    expect(r.problems).toEqual([
      'The link’s Leaver wasn’t used: Expected a GUID.',
      'The link’s Hours wasn’t used: Must be at most 72.',
    ]);
  });

  it('reports unreadable or unknown encoded inputs', () => {
    expect(prefillFromSearch(rb, { inputs: '%%%' }, decodeParam).problems).toEqual([
      'The prefilled inputs in the link could not be read.',
    ]);
    expect(prefillFromSearch(rb, { inputs: encodeParam({ extra: 1 }) }, decodeParam).problems[0]).toMatch(
      /doesn’t take \(extra\)/,
    );
  });
});
