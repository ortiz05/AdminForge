import { loadConfig } from '@adminforge/api/src/config';

/** AF_QUERY_SOURCES: the Query Studio sources an installation offers (routes/query.ts refuses the others). */
const base = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:5173',
  AUTH_MODE: 'mock',
  DATA_MODE: 'fixtures',
};

describe('AF_QUERY_SOURCES', () => {
  it('offers every source when unset or empty', () => {
    const all = ['resourceGraph', 'logAnalytics', 'advancedHunting'];
    expect(loadConfig(base).AF_QUERY_SOURCES).toEqual(all);
    expect(loadConfig({ ...base, AF_QUERY_SOURCES: '' }).AF_QUERY_SOURCES).toEqual(all);
    expect(loadConfig({ ...base, AF_QUERY_SOURCES: '   ' }).AF_QUERY_SOURCES).toEqual(all);
  });

  it('keeps the listed sources, trimmed and without repeats', () => {
    expect(
      loadConfig({ ...base, AF_QUERY_SOURCES: ' resourceGraph, logAnalytics ,resourceGraph' })
        .AF_QUERY_SOURCES,
    ).toEqual(['resourceGraph', 'logAnalytics']);
  });

  it('fails loading on an unknown source, naming the key and the accepted names', () => {
    expect(() => loadConfig({ ...base, AF_QUERY_SOURCES: 'resourceGraph,defender' })).toThrow(
      /AF_QUERY_SOURCES[.\d]*: must be resourceGraph, logAnalytics, advancedHunting \(comma-separated\)/,
    );
  });

  it('needs at least one source', () => {
    expect(() => loadConfig({ ...base, AF_QUERY_SOURCES: ', ,' })).toThrow(
      /AF_QUERY_SOURCES: at least one Query Studio source is required/,
    );
  });
});
