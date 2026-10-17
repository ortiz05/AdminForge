import { FakeDefinitions, probe, READER, schedulesApp } from './schedules-helpers';

// Each probe carries what it checks (summary), what to do when it warns or fails (remedy) and where to act (link), so
// Synthetic monitoring can show them next to the result instead of sending engineers looking.
describe('probe guidance in the probes API', () => {
  it('returns summary, remedy and link with each probe, also to Readers', async () => {
    const defs = new FakeDefinitions().set(
      probe('probes.saml-expiring', {
        check: { kind: 'graphCount', path: '/servicePrincipals', items: '${ value }' },
        summary: 'Counts SAML apps whose signing certificate expires within 30 days.',
        remedy: 'Create a new certificate, upload it to the app, then make it active.',
        link: { label: 'Open SAML certificate expiry', href: '/p/identity.saml-certificate-expiry' },
        thresholds: { warn: 1 },
      }),
    );
    const t = await schedulesApp({ defs });
    const reader = await t.login(READER, ['Portal.Reader']);
    const [item] = (await reader.get('/api/probes')).json().items;
    expect(item).toMatchObject({
      key: 'probes.saml-expiring',
      summary: 'Counts SAML apps whose signing certificate expires within 30 days.',
      remedy: 'Create a new certificate, upload it to the app, then make it active.',
      link: { label: 'Open SAML certificate expiry', href: '/p/identity.saml-certificate-expiry' },
    });
    await t.close();
  });
});
