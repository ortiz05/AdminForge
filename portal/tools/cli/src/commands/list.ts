/**
 * `adminforge list [--kind k] [--section s] [--status s] [--search text] [--json]` — what exists in portal/content,
 * so people and Claude Code find a definition to extend before adding a near-duplicate (CLAUDE.md rule 4).
 *
 * One row per definition: id, kind, section, status and file (relative to the content directory). Folders follow
 * ids (portal/content/README.md), so the section is where a definition shows, not where it is filed: a page's,
 * dashboard's, playbook's or runbook's `nav.section`, a report's `area` (its Reports catalogue area), a probe's
 * `group`, and for a schedule the section of the report, playbook or probe it runs; otherwise the id prefix. The
 * Exchange pages and reports kept under `m365/` therefore list as `exchange`. Rows are sorted by section, kind and id.
 *
 * Filters take comma-separated values and combine: `--kind` (a kind or its folder name), `--section` (matches the
 * section shown, `nav.section`, the id prefix — the folder — or a tag, so the Exchange playbooks, which have no
 * navigation entry and keep `m365.*` ids, are found by their `exchange` tag), `--status` (`active` when unset),
 * `--search` (every word must appear in the id, title, summary, tags, file or section; any case). Retired
 * definitions are listed — the status column says so — because reviving or extending one beats writing it again.
 *
 * Reads the content directory only (CONTENT_DIR overrides it); no network, no database, no admin credentials. Files
 * that don't parse are left out with a count (`adminforge validate` says why). `--json` prints the rows as JSON
 * (adding title, owner, version, tags and the preview flag) and nothing else. Exit 0 whenever the files could be
 * read, matches or not; an unknown kind or status is a ConfigError.
 */
import { ContentStatus, KINDS, loadContentDir, type Definition, type Kind } from '@adminforge/schemas';
import type { ContentCliContext } from '../content/context';
import { SCAFFOLD_KINDS } from '../content/scaffold';
import { ConfigError } from '../shared/errors';

export interface ListOptions {
  kind?: string;
  section?: string;
  status?: string;
  search?: string;
  json?: boolean;
}

export interface ListedDefinition {
  id: string;
  kind: Kind;
  section: string;
  status: string;
  preview: boolean;
  title: string;
  owner: string;
  version: string;
  tags: string[];
  file: string;
}

const prefixOf = (id: string) => id.slice(0, id.indexOf('.'));

/** `a,b , c` → ['a', 'b', 'c']; undefined (no filter) when the option wasn't given or is empty. */
function values(option?: string): string[] | undefined {
  const given = (option ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return given.length ? given : undefined;
}

/** Kind names from `--kind`: the kind (`page`) or its folder (`pages`). */
function kindsFrom(option?: string): Set<Kind> | undefined {
  const given = values(option);
  if (!given) return undefined;
  const byFolder = new Map<string, Kind>(
    Object.entries(SCAFFOLD_KINDS).map(([kind, folder]) => [folder, kind as Kind]),
  );
  return new Set(
    given.map((v) => {
      const kind = (KINDS as readonly string[]).includes(v) ? (v as Kind) : byFolder.get(v);
      if (!kind) throw new ConfigError(`Unknown kind "${v}". Use ${KINDS.join(', ')}.`);
      return kind;
    }),
  );
}

function statusesFrom(option?: string): Set<string> | undefined {
  const given = values(option);
  if (!given) return undefined;
  for (const v of given)
    if (!(ContentStatus.options as readonly string[]).includes(v))
      throw new ConfigError(`Unknown status "${v}". Use ${ContentStatus.options.join(', ')}.`);
  return new Set(given);
}

/**
 * Where a definition shows: `nav.section`, a report's `area`, a probe's `group`, a schedule's target's section —
 * else its id prefix. `byId` resolves schedule targets.
 */
export function sectionOf(def: Definition, byId: ReadonlyMap<string, Definition>): string {
  switch (def.kind) {
    case 'report':
      return def.area ?? prefixOf(def.id);
    case 'probe':
      return def.group ?? prefixOf(def.id);
    case 'page':
    case 'dashboard':
    case 'playbook':
    case 'runbook':
      return def.nav?.section ?? prefixOf(def.id);
    case 'schedule': {
      const ref = 'ref' in def.job ? def.job.ref : undefined;
      const target = ref ? byId.get(ref) : undefined;
      return target && target.kind !== 'schedule' ? sectionOf(target, byId) : prefixOf(def.id);
    }
    default:
      return prefixOf(def.id);
  }
}

/** Fixed-width columns, two spaces apart (the last one not padded). */
function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((cell, i) => (i < r.length - 1 ? cell.padEnd(widths[i]!) : cell)).join('  '));
}

/** `adminforge list` — prints the matching definitions and returns them. */
export async function listContent(
  ctx: Pick<ContentCliContext, 'contentDir' | 'out'>,
  opts: ListOptions = {},
): Promise<ListedDefinition[]> {
  const kinds = kindsFrom(opts.kind);
  const statuses = statusesFrom(opts.status);
  const sections = values(opts.section);
  const words = opts.search?.toLowerCase().split(/\s+/).filter(Boolean);

  const { definitions, errors } = await loadContentDir(ctx.contentDir, { references: false });
  const byId = new Map(definitions.map((d) => [d.def.id, d.def]));
  const kindOrder = (k: Kind) => KINDS.indexOf(k);
  const rows = definitions
    .map((d) => {
      const def = d.def;
      const row: ListedDefinition = {
        id: def.id,
        kind: def.kind,
        section: sectionOf(def, byId),
        status: def.status ?? 'active',
        preview: def.preview === true,
        title: def.title,
        owner: def.owner,
        version: def.version,
        tags: def.tags ?? [],
        file: d.file,
      };
      const placements = new Set([
        row.section,
        prefixOf(def.id),
        ...('nav' in def && def.nav ? [def.nav.section] : []),
        ...row.tags,
      ]);
      const text = [row.id, row.title, def.summary ?? '', row.tags.join(' '), row.file, row.section]
        .join('\n')
        .toLowerCase();
      const keep =
        (!kinds || kinds.has(row.kind)) &&
        (!statuses || statuses.has(row.status)) &&
        (!sections || sections.some((s) => placements.has(s))) &&
        (!words || words.every((w) => text.includes(w)));
      return keep ? row : null;
    })
    .filter((r): r is ListedDefinition => r !== null)
    .sort(
      (a, b) =>
        a.section.localeCompare(b.section) ||
        kindOrder(a.kind) - kindOrder(b.kind) ||
        a.id.localeCompare(b.id),
    );

  if (opts.json) {
    ctx.out(JSON.stringify(rows, null, 2));
    return rows;
  }
  if (rows.length)
    for (const line of table([
      ['id', 'kind', 'section', 'status', 'file'],
      ...rows.map((r) => [r.id, r.kind, r.section, r.status, r.file]),
    ]))
      ctx.out(line);
  const unreadable = new Set(errors.map((e) => e.file)).size;
  if (unreadable)
    ctx.out(
      unreadable === 1
        ? '⚠ 1 file could not be read and is not listed: adminforge validate says why.'
        : `⚠ ${unreadable} files could not be read and are not listed: adminforge validate says why.`,
    );
  ctx.out(`${rows.length} of ${definitions.length} definitions.`);
  return rows;
}
