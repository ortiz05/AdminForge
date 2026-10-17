import { validateReferences, type Page, type Probe } from '@adminforge/schemas';
import { ENVELOPE, errors, ok } from './helpers';

// A probe says what to do when it warns or fails (`remedy`) and where to act (`link`): an AdminForge page, which must
// exist, or a Microsoft admin centre over https.
const probe = (extra: string, id = 'probes.example') =>
  `${ENVELOPE('probe', id)}check:\n  kind: graph\n  path: /organization\n${extra}`;

describe('probe guidance', () => {
  it('accepts a remedy and an in-app or https link', () => {
    const def = ok<Probe>(
      probe(
        'remedy: Renew the certificate before it expires.\nlink: { label: Open the report, href: "/p/identity.users?status=Failure" }\n',
      ),
    );
    expect(def.remedy).toBe('Renew the certificate before it expires.');
    expect(def.link).toEqual({ label: 'Open the report', href: '/p/identity.users?status=Failure' });
    expect(
      ok<Probe>(
        probe(
          'link: { label: Message trace, href: "https://admin.exchange.microsoft.com/#/messagetrace" }\n',
        ),
      ).link?.href,
    ).toMatch(/^https:/);
  });

  it.each([
    ['http://admin.microsoft.com/'],
    ['javascript:alert(1)'],
    ['admin.microsoft.com'],
    ['/p/identity.users with spaces'],
    ['//evil.example.com/p/x'],
    ['/\\evil.example.com'],
  ])('refuses the link %s', (href) =>
    expect(
      errors(probe(`link: { label: Open, href: ${JSON.stringify(href)} }\n`)).map((e) => e.path),
    ).toContain('link.href'),
  );

  it('refuses an empty or very long remedy', () => {
    expect(errors(probe('remedy: ""\n')).map((e) => e.path)).toContain('remedy');
    expect(errors(probe(`remedy: ${'x'.repeat(1001)}\n`)).map((e) => e.path)).toContain('remedy');
  });

  it('checks that a /p/ link names a page, dashboard or report', () => {
    const page = {
      file: 'users.page.yaml',
      def: ok<Page>(
        `${ENVELOPE('page', 'identity.users')}template: dashboard\nlayout:\n  - { widget: markdown, text: Hello }\n`,
      ),
    };
    const p = (id: string, href: string) => ({
      file: `${id}.probe.yaml`,
      def: ok<Probe>(probe(`link: { label: Open, href: ${JSON.stringify(href)} }\n`, id)),
    });
    const found = validateReferences([
      page,
      p('probes.ok', '/p/identity.users?status=Failure'),
      p('probes.external', 'https://admin.microsoft.com/#/Domains'),
      p('probes.monitoring', '/monitoring?group=identity'),
      p('probes.missing', '/p/identity.nope'),
      p('probes.wrong-kind', '/p/probes.ok'),
      p('probes.malformed', '/p/%E0%A4%A'),
    ]).map((e) => `${e.file} ${e.path}: ${e.message}`);
    expect(found).toEqual([
      'probes.missing.probe.yaml link.href: Unknown page or dashboard or report "identity.nope".',
      'probes.wrong-kind.probe.yaml link.href: "probes.ok" is a probe, expected page or dashboard or report.',
      'probes.malformed.probe.yaml link.href: "%E0%A4%A" isn\'t a valid page key (a malformed % escape).',
    ]);
  });
});
