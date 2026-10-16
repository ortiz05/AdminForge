import type { FeedCollector } from '@adminforge/schemas';
import { isCitationUrl } from '@adminforge/schemas';
import { AppError } from '../../errors';
import { htmlToText } from '../text';
import type { Candidate } from '../types';
import { parseFeed, parseFeedDate } from '../xml';
import { day, facts, type Collector } from './shared';

/**
 * New versions of PowerShell Gallery packages — the modules AdminForge's runner loads (ExchangeOnlineManagement,
 * MicrosoftTeams, PnP.PowerShell, …) — from the gallery's NuGet v2 OData feed (Atom: m:properties → d:Id, d:Version,
 * d:Published (UTC, no zone suffix), d:IsPrerelease, d:ReleaseNotes, d:GalleryDetailsUrl). Unlisted versions (published
 * 1900-01-01) are skipped; prereleases only with `prerelease: true`. A new major version is marked high severity.
 */

type PsGallery = Extract<FeedCollector, { kind: 'psGallery' }>;

export const GALLERY_API = 'https://www.powershellgallery.com/api/v2/';

/** Same rule as the schema's PackageId: checked again here because the id goes into an OData query. */
const PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** The newest `top` versions of one package (listed only; prereleases unless asked for). */
export function galleryVersionsUrl(id: string, top: number, prerelease = false): string {
  if (!PACKAGE_ID.test(id))
    throw new AppError(400, 'content_error', 'The feed lists an invalid PowerShell Gallery package id.');
  const q: Array<[string, string]> = [
    ['id', `'${id}'`],
    ...(prerelease ? [] : ([['$filter', 'IsPrerelease eq false']] as Array<[string, string]>)),
    ['$orderby', 'Published desc'],
    ['$top', String(Math.max(1, Math.trunc(top)))],
    ['$select', 'Id,Version,Published,IsPrerelease,ReleaseNotes,GalleryDetailsUrl'],
  ];
  return `${GALLERY_API}FindPackagesById()?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

export const galleryPackageLink = (id: string, version: string) =>
  `https://www.powershellgallery.com/packages/${encodeURIComponent(id)}/${encodeURIComponent(version)}`;

const GALLERY_HOST = new URL(GALLERY_API).hostname;
const isGalleryLink = (raw: string) => {
  if (!raw || !isCitationUrl(raw)) return false;
  try {
    return new URL(raw).hostname.toLowerCase() === GALLERY_HOST;
  } catch {
    return false;
  }
};

const major = (v: string) => Number(/^(\d+)/.exec(v)?.[1] ?? NaN);

interface Version {
  id: string;
  version: string;
  published: Date;
  prerelease: boolean;
  notes: string;
  /** GalleryDetailsUrl (the package version's page). */
  link: string;
}

export function galleryVersions(text: string, wanted: string): Version[] {
  return parseFeed(text)
    .entries.map((e) => {
      const p = e.properties;
      const version = (p.NormalizedVersion || p.Version || '').trim();
      const published = parseFeedDate(p.Published || e.published);
      const id = (p.Id || e.title || wanted).trim();
      if (!version || !published || id.toLowerCase() !== wanted.toLowerCase()) return null;
      return {
        id,
        version,
        published,
        prerelease: p.IsPrerelease?.toLowerCase() === 'true' || version.includes('-'),
        notes: p.ReleaseNotes ?? '',
        link: (p.GalleryDetailsUrl ?? '').trim(),
      };
    })
    .filter((v): v is Version => v !== null)
    .sort((a, b) => b.published.getTime() - a.published.getTime());
}

export function versionToCandidate(v: Version, previous: Version | undefined): Candidate {
  const notes = htmlToText(v.notes);
  const newMajor =
    !!previous && Number.isFinite(major(v.version)) && major(v.version) > major(previous.version);
  return {
    externalId: `${v.id}@${v.version}`,
    title: `${v.id} ${v.version}${v.prerelease ? ' (prerelease)' : ''}`,
    summary:
      notes ||
      `Version ${v.version} of the ${v.id} PowerShell module was published to the PowerShell Gallery.`,
    // The gallery's own page for the version; a details link elsewhere is replaced by the gallery's URL for it.
    url: isGalleryLink(v.link) ? v.link : galleryPackageLink(v.id, v.version),
    kind: 'release',
    severity: newMajor ? 'high' : 'normal',
    status: null,
    publishedAt: v.published,
    updatedAt: null,
    actionRequiredBy: null,
    services: [v.id],
    categories: ['PowerShell module', ...(v.prerelease ? ['Prerelease'] : [])],
    tags: ['powershell', ...(newMajor ? ['major-version'] : [])],
    audience: [],
    facts: facts([
      ['Package', v.id],
      ['Version', v.version],
      ['Previous version', previous?.version],
      ['Published', day(v.published)],
      ['Prerelease', v.prerelease ? 'Yes' : null],
    ]),
  };
}

export const collectPsGallery: Collector<PsGallery> = async (ctx, deps) => {
  const c = ctx.feed.collector;
  const candidates: Candidate[] = [];
  for (const id of c.packages) {
    // One more than we keep, so the oldest kept version still knows its predecessor (major-version check).
    const res = await deps.fetchFeed(galleryVersionsUrl(id, c.versions + 1, c.prerelease), {
      signal: ctx.signal,
    });
    if (res.status === 'not_modified') continue;
    const versions = galleryVersions(res.text, id).filter((v) => c.prerelease || !v.prerelease);
    const kept = versions.slice(0, c.versions);
    kept.forEach((v, i) => candidates.push(versionToCandidate(v, versions[i + 1])));
  }
  return { candidates };
};
