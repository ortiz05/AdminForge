import path from 'node:path';
import { classify, type ClassifiableItem } from '@adminforge/api/src/news/classify';
import { loadContentDir, type Feed } from '@adminforge/schemas';
import { repoRoot } from '../lib/repo';

// Golden classification of the production feed rules (portal/content/feeds): synthetic items modelled on what each
// source publishes — relevant ones land in the right AdminForge area with the right kind/status/tags, look-alikes and
// services AdminForge doesn't manage are dropped.

const loaded = await loadContentDir(path.join(repoRoot, 'portal/content'));
const feed = (id: string) => {
  const def = loaded.definitions.find((d) => d.def.id === id)?.def as Feed | undefined;
  if (!def) throw new Error(`no feed ${id}`);
  return def;
};
const item = (over: Partial<ClassifiableItem>): ClassifiableItem => ({
  services: [],
  categories: [],
  title: '',
  summary: '',
  kind: 'info',
  severity: 'normal',
  tags: [],
  ...over,
});

describe('Azure Updates', () => {
  const f = feed('feeds.azure-updates');

  it('places an Azure Monitor retirement in azure as a retirement', () => {
    const c = classify(
      f,
      item({
        title: 'Retirement: Example legacy agent for Azure Monitor',
        categories: ['Retirements', 'Azure Monitor', 'Management and governance'],
        kind: 'retirement',
      }),
    );
    expect(c).toMatchObject({ areas: ['azure'], kind: 'retirement', status: 'Retiring' });
    expect(c!.tags).toContain('monitor');
  });

  it('marks launches and previews with their status', () => {
    expect(
      classify(f, item({ title: '[Launched] Example', categories: ['Launched', 'Feature', 'Key Vault'] })),
    ).toMatchObject({ areas: ['azure'], kind: 'feature', status: 'Launched', tags: ['key-vault'] });
    expect(
      classify(f, item({ title: '[In preview] Example', categories: ['In preview', 'Azure Functions'] })),
    ).toMatchObject({ kind: 'preview', status: 'In preview', tags: ['functions'] });
  });

  it('drops products AdminForge does not manage', () => {
    expect(
      classify(
        f,
        item({ title: '[Launched] Example', categories: ['Launched', 'Azure Kubernetes Service (AKS)'] }),
      ),
    ).toBeNull();
    expect(
      classify(f, item({ title: 'Retirement: Example', categories: ['Retirements', 'Internet of Things'] })),
    ).toBeNull();
  });

  it('puts Defender for Cloud in azure and security', () => {
    expect(
      classify(f, item({ categories: ['Launched', 'Microsoft Defender for Cloud'] }))!.areas.sort(),
    ).toEqual(['azure', 'security']);
  });
});

describe('Microsoft 365 Roadmap', () => {
  const f = feed('feeds.m365-roadmap');

  it('keeps a Teams feature that is rolling out, with its status', () => {
    expect(
      classify(
        f,
        item({
          title: 'Microsoft Teams: Example meeting setting',
          categories: [
            'Rolling out',
            'General Availability',
            'Worldwide (Standard Multi-Tenant)',
            'Microsoft Teams',
            'Web',
          ],
          kind: 'preview',
        }),
      ),
    ).toMatchObject({ areas: ['m365'], tags: ['teams'], kind: 'feature', status: 'Rolling out' });
  });

  it('drops Viva, Copilot and Dynamics items, and cancelled features', () => {
    expect(classify(f, item({ categories: ['In development', 'Microsoft Viva'] }))).toBeNull();
    expect(classify(f, item({ categories: ['Launched', 'Microsoft Copilot (Microsoft 365)'] }))).toBeNull();
    expect(classify(f, item({ categories: ['Cancelled', 'Microsoft Teams'] }))).toBeNull();
  });

  it('maps Entra and Intune to their areas', () => {
    expect(classify(f, item({ categories: ['In development', 'Microsoft Entra'] }))).toMatchObject({
      areas: ['identity'],
      status: 'In development',
    });
    expect(classify(f, item({ categories: ['Launched', 'Microsoft Intune'] }))!.areas).toEqual(['endpoint']);
  });
});

describe('MSRC Security Update Guide', () => {
  const f = feed('feeds.msrc-security');

  it('keeps cloud-service CVEs AdminForge manages, as security', () => {
    expect(
      classify(
        f,
        item({
          title: 'CVE-2026-90002 Microsoft Entra ID Elevation of Privilege Vulnerability',
          categories: ['CVE'],
        }),
      ),
    ).toMatchObject({ kind: 'security', tags: ['entra'] });
    expect(
      classify(
        f,
        item({ title: 'CVE-2026-90001 Microsoft Exchange Online Spoofing Vulnerability' }),
      )!.areas.sort(),
    ).toEqual(['m365', 'security']);
    expect(
      classify(
        f,
        item({ title: 'CVE-2026-90004 Azure Arc Elevation of Privilege Vulnerability' }),
      )!.areas.sort(),
    ).toEqual(['azure', 'security']);
  });

  it('drops on-premises and unrelated look-alikes', () => {
    for (const title of [
      'CVE-2026-90005 Windows Internet Key Exchange (IKE) Protocol Denial of Service Vulnerability',
      'CVE-2026-90006 Microsoft Exchange Server Remote Code Execution Vulnerability',
      'CVE-2026-90007 Microsoft SharePoint Server Spoofing Vulnerability',
      'CVE-2026-90008 Microsoft Graphics Component Information Disclosure Vulnerability',
      'CVE-2026-90009 Windows PowerShell Security Feature Bypass Vulnerability',
      'CVE-2026-90010 Windows Defender Firewall Service Elevation of Privilege Vulnerability',
      'Chromium: CVE-2026-90011 Use after free in Example',
    ])
      expect(classify(f, item({ title })), title).toBeNull();
  });

  it('keeps PowerShell and Microsoft Graph CVEs on the platform', () => {
    expect(
      classify(f, item({ title: 'CVE-2026-90012 PowerShell Remote Code Execution Vulnerability' })),
    ).toMatchObject({
      tags: ['powershell'],
    });
    expect(
      classify(f, item({ title: 'CVE-2026-90013 Microsoft Graph Information Disclosure Vulnerability' }))!
        .areas,
    ).toContain('platform');
  });
});

describe('Message Center and service health', () => {
  it('keeps Message Center posts for managed services only', () => {
    const f = feed('feeds.m365-message-center');
    expect(classify(f, item({ services: ['Exchange Online'], kind: 'change' }))).toMatchObject({
      areas: ['m365'],
      tags: ['exchange'],
      kind: 'change',
    });
    expect(classify(f, item({ services: ['Microsoft Intune'] }))!.areas).toEqual(['endpoint']);
    expect(classify(f, item({ services: ['Microsoft Viva'] }))).toBeNull();
    expect(classify(f, item({ services: ['Power Platform'] }))).toBeNull();
  });

  it('keeps every Microsoft 365 health issue, placing managed services in their area', () => {
    const f = feed('feeds.m365-service-health');
    expect(classify(f, item({ services: ['Microsoft Entra'], kind: 'incident' }))!.areas).toEqual([
      'identity',
    ]);
    expect(classify(f, item({ services: ['Planner'], kind: 'incident' }))!.areas).toEqual(['m365']);
  });

  it('keeps every Azure Service Health event in azure, tagged by service', () => {
    const f = feed('feeds.azure-service-health');
    expect(classify(f, item({ services: ['Virtual Machines'], kind: 'incident' }))).toMatchObject({
      areas: ['azure'],
      tags: ['vms'],
    });
    expect(classify(f, item({ services: ['Example Service'], kind: 'maintenance' }))!.areas).toEqual([
      'azure',
    ]);
  });
});

describe('blogs, Learn and modules', () => {
  it('drops on-premises Exchange Server release posts but keeps Exchange Online posts', () => {
    const f = feed('feeds.exchange-blog');
    expect(
      classify(f, item({ title: 'Released: October 2026 Exchange Server Security Updates' })),
    ).toBeNull();
    expect(
      classify(
        f,
        item({ title: 'Example: Exchange Online mailbox audit change', summary: 'Exchange Online' }),
      ),
    ).toMatchObject({ areas: ['m365'], tags: ['exchange'] });
  });

  it('marks retirement posts as retirements', () => {
    expect(
      classify(
        feed('feeds.entra-blog'),
        item({ title: 'Example: Retirement of an example Entra sign-in setting' }),
      ),
    ).toMatchObject({ kind: 'retirement', areas: ['identity'], tags: ['entra'] });
  });

  it('classifies Graph changelog workloads and keeps every item on the platform', () => {
    const f = feed('feeds.graph-changelog');
    const c = classify(f, item({ title: 'Identity and access', categories: ['Prod', 'v1.0'] }))!;
    expect(c.areas.sort()).toEqual(['identity', 'platform']);
    expect(c.tags).toContain('graph-api');
    expect(
      classify(f, item({ title: 'Device and app management', categories: ['prd', 'beta'] }))!.tags,
    ).toContain('graph-beta');
  });

  it('puts module releases on the platform and in the workload they serve', () => {
    expect(
      classify(
        feed('feeds.powershell-modules'),
        item({ services: ['MicrosoftTeams'], kind: 'release' }),
      )!.areas.sort(),
    ).toEqual(['m365', 'platform']);
    expect(
      classify(feed('feeds.pnp-powershell'), item({ services: ['PnP.PowerShell'], kind: 'release' })),
    ).toMatchObject({ tags: ['sharepoint'], kind: 'release' });
  });
});
