import { XMLParser } from 'fast-xml-parser';
import { AppError } from '../errors';
import { decodeXmlEntities } from './text';

/**
 * RSS 2.0 / RSS 1.0 / Atom (and the PowerShell Gallery's OData Atom) → plain entries.
 *
 * Hardening: a document with a DOCTYPE or ENTITY declaration is refused before parsing (no DTDs, so no external
 * entities and no entity-expansion bombs); the parser never processes entities; only the five XML entities and numeric
 * character references are decoded afterwards; nesting is capped. Values are kept as strings (no number parsing).
 */

export interface FeedEntry {
  /** guid / id. */
  id: string;
  title: string;
  link: string;
  /** Raw date strings as the feed wrote them. */
  published: string;
  updated: string;
  /** HTML or text (description, content:encoded, summary, content). */
  summary: string;
  categories: string[];
  /** OData `m:properties` (PowerShell Gallery), flattened to text. */
  properties: Record<string, string>;
}

export interface ParsedFeed {
  format: 'rss' | 'atom';
  /** Channel / feed title. */
  title: string;
  entries: FeedEntry[];
}

export const feedUnreadable = (why: string) =>
  new AppError(502, 'feed_unreadable', `The feed could not be read: ${why}.`, {
    hint: 'The source may have changed its format. Check the feed URL in its definition; the next hourly run tries again.',
  });

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
  cdataPropName: '__cdata',
  ignoreDeclaration: true,
  ignorePiTags: true,
  maxNestedTags: 64,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'category' || name === 'link',
});

type Node = unknown;

/** Text content of an element: XML-decoded text plus raw CDATA (CDATA is never entity-decoded). */
export function textOf(node: Node): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return decodeXmlEntities(node);
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) {
    for (const n of node) {
      const t = textOf(n);
      if (t) return t;
    }
    return '';
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const text = o['#text'] === undefined ? '' : textOf(o['#text']);
    const cdata = o.__cdata === undefined ? '' : [o.__cdata].flat().map(String).join('');
    return `${text}${cdata}`.trim();
  }
  return '';
}

const attr = (node: Node, name: string): string => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return '';
  const v = (node as Record<string, unknown>)[`@_${name}`];
  return typeof v === 'string' ? decodeXmlEntities(v) : '';
};

const list = (node: Node): Node[] => (node === undefined || node === null ? [] : [node].flat());

const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s.trim());

function rssLink(item: Record<string, unknown>): string {
  for (const l of list(item.link)) {
    const t = textOf(l);
    if (looksLikeUrl(t)) return t.trim();
    const href = attr(l, 'href');
    if (looksLikeUrl(href) && (!attr(l, 'rel') || attr(l, 'rel') === 'alternate')) return href.trim();
  }
  return '';
}

function atomLink(entry: Record<string, unknown>): string {
  const links = list(entry.link);
  const alternate =
    links.find((l) => attr(l, 'rel') === 'alternate' && looksLikeUrl(attr(l, 'href'))) ??
    links.find((l) => !attr(l, 'rel') && looksLikeUrl(attr(l, 'href')));
  return alternate ? attr(alternate, 'href').trim() : '';
}

function properties(node: Node): Record<string, string> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith('@_') || k === '#text') continue;
    out[k] = textOf(v);
  }
  return out;
}

function rssEntry(item: Record<string, unknown>): FeedEntry {
  return {
    id: textOf(item.guid),
    title: textOf(item.title),
    link: rssLink(item),
    published: textOf(item.pubDate) || textOf(item.date),
    updated: textOf(item.updated),
    summary: textOf(item.description) || textOf(item.encoded),
    categories: list(item.category)
      .map((c) => textOf(c))
      .filter(Boolean),
    properties: {},
  };
}

function atomEntry(entry: Record<string, unknown>): FeedEntry {
  const content = entry.content as Record<string, unknown> | undefined;
  return {
    id: textOf(entry.id),
    title: textOf(entry.title),
    link: atomLink(entry),
    published: textOf(entry.published) || textOf(entry.issued),
    updated: textOf(entry.updated) || textOf(entry.modified),
    summary: textOf(entry.summary) || textOf(entry.content),
    categories: list(entry.category)
      .map((c) => attr(c, 'term') || attr(c, 'label') || textOf(c))
      .filter(Boolean),
    properties: properties(entry.properties ?? content?.properties),
  };
}

/** Refuses DTDs outright: no DOCTYPE, no ENTITY declarations (XXE and entity-expansion bombs). */
export function assertSafeXml(text: string): void {
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(text))
    throw feedUnreadable('it declares a DTD, which AdminForge does not accept');
}

export function parseFeed(text: string): ParsedFeed {
  assertSafeXml(text);
  if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*</.test(text)) throw feedUnreadable('it is not XML');
  let doc: Record<string, unknown>;
  try {
    // `true`: validate first, so malformed XML is refused instead of half-read.
    const parsed = parser.parse(text, true) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not XML');
    doc = parsed as Record<string, unknown>;
  } catch {
    throw feedUnreadable('it is not well-formed XML');
  }
  const rss = doc.rss as Record<string, unknown> | undefined;
  const rdf = doc.RDF as Record<string, unknown> | undefined;
  if (rss || rdf) {
    const channel = (rss?.channel ?? rdf) as Record<string, unknown> | undefined;
    const items = list(channel?.item ?? rdf?.item);
    return {
      format: 'rss',
      title: textOf(channel?.title),
      entries: items
        .filter((i) => i && typeof i === 'object')
        .map((i) => rssEntry(i as Record<string, unknown>)),
    };
  }
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) {
    return {
      format: 'atom',
      title: textOf(feed.title),
      entries: list(feed.entry)
        .filter((e) => e && typeof e === 'object')
        .map((e) => atomEntry(e as Record<string, unknown>)),
    };
  }
  throw feedUnreadable('it is neither RSS nor Atom');
}

/**
 * A feed date (RFC 822 or ISO 8601) → Date, or null. Zone-less ISO values (OData Edm.DateTime) are UTC; dates before
 * 1990 (the gallery's "unlisted" 1900-01-01) count as missing.
 */
export function parseFeedDate(raw: string | null | undefined): Date | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s}Z` : s;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return d.getUTCFullYear() < 1990 ? null : d;
}
