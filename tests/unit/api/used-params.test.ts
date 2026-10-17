import { paramsUsed } from '@adminforge/api/src/datasources/used-params';

// Datasource cache keys count only the params a datasource uses; every way of reaching params without naming one
// means "all of them", so one filter's results are never served for another.
describe('paramsUsed', () => {
  it.each([
    ['params.q', ['q']],
    ["'x eq ' & $odata(params.q) & ' and ' & params.top", ['q', 'top']],
    ['value.value[x = params.q]', ['q']],
    ['value.value[$.x > 1].id', []],
    ['value.value.($.x)', []],
    ['$count(value.value)', []],
  ])('%s → %j', (src, expected) => {
    expect(paramsUsed(src)).toEqual(expected);
  });

  it.each([
    ['params'],
    ['params[0]'],
    ["$lookup(params, 'q')"],
    ['$keys(params)'],
    ['$.*.q'],
    ['**.q'],
    ['*.q'],
    ['$$.params.q'],
    ['$.params.q'],
    ['$each($, function($v) { $v })'],
    ['$sift($, function($v, $k) { $k = "params" })'],
    ['{ "all": $ }'],
    ['(((('], // unparseable: all
  ])('%s → all params', (src) => {
    expect(paramsUsed(src)).toBe('*');
  });
});
