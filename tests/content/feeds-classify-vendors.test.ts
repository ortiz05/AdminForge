import path from 'node:path';
import { isBreaking } from '@adminforge/api/src/news/breaking';
import { classify, type ClassifiableItem } from '@adminforge/api/src/news/classify';
import { loadContentDir, type Feed } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Golden classification of the vendor feeds (ADR-013 addendum, 2026-10-23): each vendor's own status page, blog or
// release feed lands in its area (infrastructure: VMware, ESXi, HPE; ai: Anthropic, OpenRouter, n8n; security: DigiCert,
// the Microsoft Security Blog; azure: AVD), and the noise each one carries — moving release tags, comparison pieces,
// corporate news — is dropped. Synthetic items modelled on what each publishes.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const feed = (id: string) => {
  const def = loaded.definitions.find((d) => d.def.id === id)?.def as Feed | undefined;
  if (!def) throw new Error(`no feed ${id}`);
  return def;
};
const item = (title: string, summary = ''): ClassifiableItem => ({
  services: [],
  categories: [],
  title,
  summary,
  kind: 'info',
  severity: 'normal',
  tags: [],
});

describe('AI and automation', () => {
  it('Claude status: incidents and maintenance in ai', () => {
    const f = feed('feeds.anthropic-status');
    expect(classify(f, item('Elevated errors on Claude Opus'))).toMatchObject({
      areas: ['ai'],
      kind: 'incident',
    });
    expect(classify(f, item('Scheduled maintenance for the Console'))).toMatchObject({ kind: 'maintenance' });
  });

  it('status pages: a resolved incident leaves Breaking, an ongoing one stays', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    const breaking = (summary: string) => {
      const c = classify(feed('feeds.anthropic-status'), item('Elevated errors on Claude Opus', summary))!;
      return isBreaking(
        { kind: c.kind, severity: c.severity, status: c.status, activityAt: now, actionRequiredBy: null },
        now,
      );
    };
    expect(
      breaking(
        'Oct 23, 11:00 UTC Resolved - This incident has been resolved. Oct 23, 10:00 UTC Investigating - …',
      ),
    ).toBe(false);
    expect(breaking('Oct 23, 11:30 UTC Investigating - We are looking into elevated errors.')).toBe(true);
    expect(
      classify(feed('feeds.digicert-status'), item('Delayed DigiCert issuance', 'Resolved - Fixed.')),
    ).toMatchObject({
      kind: 'incident',
      status: 'resolved',
    });
  });

  it('Claude Code: every version is a release', () => {
    const c = classify(feed('feeds.claude-code-releases'), item('v2.1.309'));
    expect(c).toMatchObject({ kind: 'release' });
    expect(c!.areas).toEqual(expect.arrayContaining(['ai', 'platform']));
    expect(c!.tags).toContain('claude-code');
  });

  it('n8n releases: each version once, without the moving stable and beta tags', () => {
    const f = feed('feeds.n8n-releases');
    expect(classify(f, item('n8n@2.45.2'))).toMatchObject({ areas: ['ai'], kind: 'release', tags: ['n8n'] });
    for (const t of ['stable', 'beta', 'v1: :rocket: Release 1.123.86 (#41364)'])
      expect(classify(f, item(t)), t).toBeNull();
  });

  it('OpenRouter: platform announcements, not tutorials or comparisons', () => {
    const f = feed('feeds.openrouter-blog');
    expect(classify(f, item('ElevenLabs is now on OpenRouter'))).toMatchObject({
      areas: ['ai'],
      kind: 'feature',
    });
    expect(classify(f, item('In-Region Routing: Route inference in the US or EU'))).not.toBeNull();
    for (const t of [
      'LangChain vs CrewAI: Orchestration Compared to OpenRouter-Native Routing',
      'How to Use OpenRouter Presets: Config-as-Code Guide',
      'Best Embedding Models in 2026',
      'Two Hours of Work That Takes a Week',
    ])
      expect(classify(f, item(t)), t).toBeNull();
  });
});

describe('Infrastructure', () => {
  it('VMware Cloud Foundation: ESXi gets its tag, end of support is a retirement', () => {
    const f = feed('feeds.vmware-cloud-foundation-blog');
    const esxi = classify(f, item('What changed in ESXi 9.1', 'ESXi and vSphere updates'));
    expect(esxi).toMatchObject({ areas: ['infrastructure'] });
    expect(esxi!.tags).toEqual(expect.arrayContaining(['vmware', 'esxi']));
    expect(classify(f, item('End of general support for vCenter 8.0'))).toMatchObject({ kind: 'retirement' });
  });

  it('HPE newsroom: servers, iLO and security bulletins kept; marketing and corporate news dropped', () => {
    const f = feed('feeds.hpe-newsroom');
    expect(classify(f, item('New HPE ProLiant servers with iLO 7'))).toMatchObject({
      areas: ['infrastructure'],
    });
    expect(classify(f, item('HPE security bulletin: iLO 6 vulnerability'))).toMatchObject({
      kind: 'security',
    });
    // "Security" in a marketing headline is not a security item.
    expect(classify(f, item('The hidden security gap in private AI'))).toBeNull();
    expect(classify(f, item('HPE and Miami HEAT transform the fan experience'))).toBeNull();
  });
});

describe('Security, Azure and Microsoft 365', () => {
  it('DigiCert status: maintenance windows and issuance incidents, in security', () => {
    const f = feed('feeds.digicert-status');
    expect(classify(f, item('DigiCert Europe QuoVadis Maintenance Window'))).toMatchObject({
      areas: ['security'],
      kind: 'maintenance',
    });
    expect(classify(f, item('Delayed DigiCert certificate issuance'))).toMatchObject({ kind: 'incident' });
  });

  it('Microsoft Security Blog: campaigns are security; Entra posts reach identity', () => {
    const f = feed('feeds.microsoft-security-blog');
    expect(classify(f, item('Large-scale campaign exploited a zero-day'))).toMatchObject({
      kind: 'security',
    });
    expect(classify(f, item('Protecting tokens', 'Microsoft Entra ID adds token protection'))!.areas).toEqual(
      expect.arrayContaining(['security', 'identity']),
    );
  });

  it('Azure Virtual Desktop: in azure with the avd tag, GA and previews marked', () => {
    const f = feed('feeds.avd-blog');
    expect(
      classify(f, item('Now generally available: Regional resiliency for Azure Virtual Desktop')),
    ).toMatchObject({
      areas: ['azure'],
      kind: 'feature',
      tags: ['avd'],
    });
    expect(classify(f, item('Public preview: example AVD feature'))).toMatchObject({ kind: 'preview' });
  });

  it('Microsoft 365 Blog: in m365, retirements marked', () => {
    expect(
      classify(feed('feeds.m365-blog'), item('Office LTSC 2021 support ends today: retirement')),
    ).toMatchObject({
      areas: ['m365'],
      kind: 'retirement',
    });
  });
});
