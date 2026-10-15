import { createGraphClient, GRAPH_ACCEPT_LANGUAGE, withAcceptLanguage } from '@adminforge/connectors';

// Node's fetch sends `Accept-Language: *`; Graph's PIM schedule-instance APIs answer that with 400
// CultureNotFoundException (they only worked inside $batch). The Graph client sends en-US unless a request sets its own.
function client() {
  const sent: Array<{ url: string; headers: Record<string, string>; body?: unknown }> = [];
  const graph = createGraphClient({
    getToken: async () => 'token',
    maxRetries: 0,
    fetch: async (input, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      sent.push({ url: String(input), headers: init?.headers as Record<string, string>, body });
      const responses = (body?.requests ?? []).map((r: { id: string }) => ({
        id: r.id,
        status: 200,
        body: {},
      }));
      return new Response(JSON.stringify(body?.requests ? { responses } : { value: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  return { graph, sent };
}

describe('Graph Accept-Language', () => {
  it('direct requests send en-US (PIM schedule instances)', async () => {
    const { graph, sent } = client();
    await graph.request({ path: '/roleManagement/directory/roleEligibilityScheduleInstances' });
    expect(GRAPH_ACCEPT_LANGUAGE).toBe('en-US');
    expect(sent[0]!.headers['Accept-Language']).toBe('en-US');
  });

  it("a request's own Accept-Language wins (any casing)", async () => {
    const { graph, sent } = client();
    await graph.request({ path: '/users', headers: { 'accept-language': 'nb-NO' } });
    const lang = Object.entries(sent[0]!.headers).filter(([k]) => k.toLowerCase() === 'accept-language');
    expect(lang).toEqual([['accept-language', 'nb-NO']]);
  });

  it('pages and $batch carry it; sub-requests with headers get it, others stay as they are', async () => {
    const { graph, sent } = client();
    await graph.all({ path: '/roleManagement/directory/roleAssignmentScheduleInstances' });
    expect(sent[0]!.headers['Accept-Language']).toBe('en-US');
    await graph.batch([
      { id: 'plain', path: '/users' },
      { id: 'count', path: '/users/$count', headers: { ConsistencyLevel: 'eventual' } },
      { id: 'own', path: '/groups', headers: { 'Accept-Language': 'de-DE' } },
    ]);
    const batch = sent[1]!;
    expect(batch.headers['Accept-Language']).toBe('en-US');
    const requests = (batch.body as { requests: Array<{ id: string; headers?: Record<string, string> }> })
      .requests;
    expect(requests.find((r) => r.id === 'plain')!.headers).toBeUndefined();
    expect(requests.find((r) => r.id === 'count')!.headers).toEqual({
      ConsistencyLevel: 'eventual',
      'Accept-Language': 'en-US',
    });
    expect(requests.find((r) => r.id === 'own')!.headers).toEqual({ 'Accept-Language': 'de-DE' });
  });

  it('withAcceptLanguage leaves the input object alone', () => {
    const h = { ConsistencyLevel: 'eventual' };
    expect(withAcceptLanguage(h)).toEqual({ ConsistencyLevel: 'eventual', 'Accept-Language': 'en-US' });
    expect(h).toEqual({ ConsistencyLevel: 'eventual' });
    expect(withAcceptLanguage(undefined)).toEqual({ 'Accept-Language': 'en-US' });
  });
});
