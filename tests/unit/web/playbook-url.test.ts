import {
  decodeParam,
  encodeParam,
  itemInputs,
  itemLabel,
  parseLaunch,
  playbookHref,
  playbookSearch,
  withoutPlaybook,
} from '@adminforge/web/src/playbooks/url';

describe('playbook launch links', () => {
  it('round-trips JSON (unicode included) through URL-safe base64', () => {
    const value = { userId: '3f2a8c1e-5b7d-4e19-9a6c-2d8e4f1b9c1d', reason: 'Zoë’s laptop — stolen ✓' };
    const text = encodeParam(value);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeParam(text)).toEqual(value);
  });

  it('tolerates hand-edited links', () => {
    expect(decodeParam('%%%')).toBeUndefined();
    expect(decodeParam(undefined)).toBeUndefined();
    expect(decodeParam('x'.repeat(70_000))).toBeUndefined();
  });

  it('builds search params and hrefs for pages, row and bulk actions', () => {
    expect(playbookSearch({ playbook: 'identity.disable-user' })).toEqual({
      playbook: 'identity.disable-user',
      inputs: undefined,
      items: undefined,
      preview: undefined,
    });
    const href = playbookHref(
      { playbook: 'identity.revoke-sessions', inputs: { reason: 'x' }, items: [{ userId: 'a' }] },
      '/p/identity.users',
    );
    expect(href.startsWith('/p/identity.users?playbook=identity.revoke-sessions&inputs=')).toBe(true);
    const parsed = parseLaunch(Object.fromEntries(new URL(href, 'http://x').searchParams));
    expect(parsed).toMatchObject({
      key: 'identity.revoke-sessions',
      keyValid: true,
      inputs: { reason: 'x' },
      items: [{ userId: 'a' }],
      problems: [],
    });
  });

  it('parseLaunch explains what was wrong instead of failing', () => {
    expect(parseLaunch({})).toBeNull();
    const bad = parseLaunch({
      playbook: 'Not A Key',
      inputs: 'garbage',
      items: encodeParam({ not: 'an array' }),
    })!;
    expect(bad.keyValid).toBe(false);
    expect(bad.problems).toHaveLength(3);
    expect(bad.inputs).toEqual({});
    expect(bad.items).toBeNull();
    expect(parseLaunch({ playbook: 'a.b', preview: 'bad id!' })!.preview).toBeNull();
  });

  it('closing keeps every other param; item labels are display-only', () => {
    expect(
      withoutPlaybook({ inspect: 'user:1', playbook: 'a.b', inputs: 'x', items: 'y', preview: 'z' }),
    ).toEqual({
      inspect: 'user:1',
      playbook: undefined,
      inputs: undefined,
      items: undefined,
      preview: undefined,
    });
    expect(itemInputs({ userId: 'a', $label: 'Adele Lee' })).toEqual({ userId: 'a' });
    expect(itemLabel({ $label: 'Adele Lee' }, 0)).toBe('Adele Lee');
    expect(itemLabel({}, 2)).toBe('Item 3');
  });
});
