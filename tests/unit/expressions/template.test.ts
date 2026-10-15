import { splitTemplate, TemplateError, wholeExpression } from '@adminforge/expressions';

describe('splitTemplate', () => {
  it('returns plain text unchanged', () =>
    expect(splitTemplate('Users')).toEqual([{ type: 'text', value: 'Users' }]));
  it('splits text and expressions', () =>
    expect(splitTemplate('/users/${ $encode(inputs.userId) }/revoke')).toEqual([
      { type: 'text', value: '/users/' },
      { type: 'expr', source: '$encode(inputs.userId)', start: 7, end: 34 },
      { type: 'text', value: '/revoke' },
    ]));
  it('tracks brace depth (JSONata object constructors)', () =>
    expect(splitTemplate('${ { "a": { "b": 1 } } }!')).toEqual([
      { type: 'expr', source: '{ "a": { "b": 1 } }', start: 0, end: 24 },
      { type: 'text', value: '!' },
    ]));
  it('ignores braces inside string literals of every quote style', () => {
    expect(splitTemplate(`\${ "}" & '{' & \`a}b\` }`)[0]).toMatchObject({
      type: 'expr',
      source: `"}" & '{' & \`a}b\``,
    });
    expect(splitTemplate('${ "a \\"}\\" b" }')[0]).toMatchObject({ source: '"a \\"}\\" b"' });
  });
  it('ignores braces inside comments', () =>
    expect(splitTemplate('${ /* } */ 1 }')[0]).toMatchObject({ source: '/* } */ 1' }));
  it('handles several expressions', () =>
    expect(splitTemplate('${a}-${b}').map((s) => (s.type === 'expr' ? s.source : s.value))).toEqual([
      'a',
      '-',
      'b',
    ]));
  it('treats $${ as a literal ${', () =>
    expect(splitTemplate('cost: $${x} and ${ y }')).toEqual([
      { type: 'text', value: 'cost: ${x} and ' },
      { type: 'expr', source: 'y', start: 16, end: 22 },
    ]));
  it.each([
    ['${ a', /Unterminated \$\{ … \} starting at position 0/],
    ['x ${ "a }', /Unterminated string literal/],
    ['${ /* }', /Unterminated comment/],
    ['${   }', /Empty/],
  ])('rejects %s', (input, message) => {
    expect(() => splitTemplate(input)).toThrow(TemplateError);
    expect(() => splitTemplate(input)).toThrow(message);
  });
});

describe('wholeExpression', () => {
  it('detects a template that is exactly one expression', () => {
    expect(wholeExpression(splitTemplate('${ row.id }'))).toBe('row.id');
    expect(wholeExpression(splitTemplate('  ${ row.id }\n'))).toBe('row.id');
  });
  it('rejects mixed templates', () => {
    expect(wholeExpression(splitTemplate('id: ${ row.id }'))).toBeUndefined();
    expect(wholeExpression(splitTemplate('${ a }${ b }'))).toBeUndefined();
    expect(wholeExpression(splitTemplate('plain'))).toBeUndefined();
  });
});
