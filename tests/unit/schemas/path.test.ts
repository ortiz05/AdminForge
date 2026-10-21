import { getPath, splitDataRef, splitPath } from '@adminforge/schemas';
import { getPath as widgetGetPath, splitDataRef as widgetSplitDataRef } from '@adminforge/widgets';

// One data-path reader for the browser (widgets) and the API (exports): `value[0].id` resolves the same on both
// sides, so a column that renders also exports (design review D-06).
describe('data paths', () => {
  const row = {
    id: 'u1',
    signInActivity: { lastSignInDateTime: '2026-10-01T08:00:00Z' },
    value: [{ id: 'first' }, { id: 'second' }],
    matrix: [[1, 2], [3]],
    counts: { members: 0 },
  };

  it('splits dot paths and [n] indexes into segments', () => {
    expect(splitPath('signInActivity.lastSignInDateTime')).toEqual(['signInActivity', 'lastSignInDateTime']);
    expect(splitPath('value[0].id')).toEqual(['value', 0, 'id']);
    expect(splitPath('matrix[1][0]')).toEqual(['matrix', 1, 0]);
    expect(splitPath('')).toEqual([]);
  });

  it('reads nested fields, list items and falsy values; missing segments are undefined, never a throw', () => {
    expect(getPath(row, 'signInActivity.lastSignInDateTime')).toBe('2026-10-01T08:00:00Z');
    expect(getPath(row, 'value[1].id')).toBe('second');
    expect(getPath(row, 'matrix[1][0]')).toBe(3);
    expect(getPath(row, 'counts.members')).toBe(0);
    expect(getPath(row, 'value[5].id')).toBeUndefined();
    expect(getPath(row, 'id.length.deeper')).toBeUndefined();
    expect(getPath(null, 'a.b')).toBeUndefined();
    expect(getPath(row, undefined)).toBe(row);
  });

  it('accepts pre-split segments (the export resolves its data path once)', () => {
    expect(getPath(row, ['value', 0, 'id'])).toBe('first');
    expect(getPath(row, [])).toBe(row);
  });

  it('never reads inherited properties', () => {
    expect(getPath({}, 'constructor')).toBeUndefined();
    expect(getPath({ a: {} }, 'a.__proto__')).toBeUndefined();
    expect(getPath([1, 2], 'length')).toBe(2);
  });

  it('splits a data reference into its datasource and the path inside it', () => {
    expect(splitDataRef('users.value')).toEqual({ root: 'users', rest: 'value' });
    expect(splitDataRef('ds.value[0].items')).toEqual({ root: 'ds', rest: 'value[0].items' });
    expect(splitDataRef('rows[0]')).toEqual({ root: 'rows', rest: '[0]' });
    expect(splitDataRef('counts')).toEqual({ root: 'counts', rest: '' });
  });

  it('the widgets package uses the same helpers', () => {
    expect(widgetGetPath).toBe(getPath);
    expect(widgetSplitDataRef).toBe(splitDataRef);
  });
});
