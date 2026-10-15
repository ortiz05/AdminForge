import { formatPath } from './common';
import type { Connection } from './connection';
import type { Definition } from './definition';
import type { Datasources } from './datasource';
import { stepMode, walkSteps, type Compensation, type Step } from './playbook';
import type { TableWidgetConfig, WidgetBlock } from './widgets';

/** A problem in a content file. `line` is 1-based when known. */
export interface ContentError {
  file: string;
  /** Dotted path into the definition, e.g. `steps[2].request.path` ('' = whole file). */
  path: string;
  line?: number;
  message: string;
}

export type PathSegment = string | number;
/** Maps a path inside a parsed definition to its 1-based source line. */
export type Locate = (path: readonly PathSegment[]) => number | undefined;

export interface DefinitionEntry {
  file: string;
  def: Definition;
  locate?: Locate;
}

const PAGE_KINDS = new Set(['page', 'dashboard', 'report']);

/**
 * Cross-file checks: unique ids, navigation sections, and every reference between pages, playbooks, runbooks,
 * reports, probes, schedules and connections (including connection operations and input names).
 */
export function validateReferences(entries: readonly DefinitionEntry[]): ContentError[] {
  const errors: ContentError[] = [];
  const byId = new Map<string, DefinitionEntry>();
  for (const e of entries) {
    const prev = byId.get(e.def.id);
    if (prev) errors.push({ file: e.file, path: 'id', line: e.locate?.(['id']), message: `Duplicate id "${e.def.id}" (also in ${prev.file}).` });
    else byId.set(e.def.id, e);
  }
  const navSections = new Set(entries.flatMap((e) => (e.def.kind === 'navigation' ? e.def.sections.map((s) => s.key) : [])));
  const hasNavigation = entries.some((e) => e.def.kind === 'navigation');

  for (const entry of entries) {
    const { def } = entry;
    const err = (path: PathSegment[], message: string) => errors.push({ file: entry.file, path: formatPath(path), line: entry.locate?.(path), message });
    const find = (id: string, kinds: string[], path: PathSegment[]): Definition | undefined => {
      const target = byId.get(id)?.def;
      if (!target) err(path, `Unknown ${kinds.join(' or ')} "${id}".`);
      else if (!kinds.includes(target.kind)) err(path, `"${id}" is a ${target.kind}, expected ${kinds.join(' or ')}.`);
      else return target;
      return undefined;
    };
    const checkInputs = (target: Definition | undefined, inputs: Record<string, unknown> | undefined, path: PathSegment[]) => {
      if (!target || !inputs || (target.kind !== 'playbook' && target.kind !== 'runbook')) return;
      for (const key of Object.keys(inputs))
        if (!target.inputs || !(key in target.inputs)) err([...path, key], `${target.kind} "${target.id}" has no input "${key}".`);
    };
    const connectionOp = (connId: string, op: string | undefined, path: PathSegment[]) => {
      const conn = find(connId, ['connection'], [...path, 'connection']) as Connection | undefined;
      if (!conn || op === undefined) return undefined;
      const operation = conn.operations[op];
      if (!operation) err([...path, 'operation'], `Connection "${connId}" has no operation "${op}".`);
      return operation;
    };
    const checkDatasources = (ds: Datasources | undefined) => {
      for (const [name, d] of Object.entries(ds ?? {})) {
        if (d.source !== 'function') continue;
        const op = connectionOp(d.connection, d.operation, ['datasources', name]);
        if (op?.mode === 'write') err(['datasources', name, 'operation'], `Datasources only read; operation "${d.operation}" is mode: write.`);
      }
    };
    const checkScopes = () => {
      for (const id of Object.keys(def.requires?.scopes?.connections ?? {})) find(id, ['connection'], ['requires', 'scopes', 'connections', id]);
    };
    checkScopes();

    if ('nav' in def && def.nav && hasNavigation && !navSections.has(def.nav.section))
      err(['nav', 'section'], `Unknown navigation section "${def.nav.section}".`);

    if (def.kind === 'page' || def.kind === 'dashboard' || def.kind === 'report') {
      checkDatasources(def.datasources);
      const blocks: Array<{ block: WidgetBlock; path: PathSegment[] }> = [
        ...(def.layout ?? []).map((block, i) => ({ block, path: ['layout', i] as PathSegment[] })),
        ...(def.tabs ?? []).flatMap((t, ti) => t.layout.map((block, i) => ({ block, path: ['tabs', ti, 'layout', i] as PathSegment[] }))),
      ];
      for (const { block, path } of blocks) {
        if (block.widget !== 'table') continue;
        const t = block as TableWidgetConfig;
        if (t.inspect) find(t.inspect.page, [...PAGE_KINDS], [...path, 'inspect', 'page']);
        t.columns?.forEach((c, i) => c.link && find(c.link.page, [...PAGE_KINDS], [...path, 'columns', i, 'link', 'page']));
        t.rowActions?.forEach((a, i) => {
          if (a.playbook) checkInputs(find(a.playbook, ['playbook', 'runbook'], [...path, 'rowActions', i, 'playbook']), a.inputs, [...path, 'rowActions', i, 'inputs']);
        });
        t.bulkActions?.forEach((a, i) =>
          checkInputs(find(a.playbook, ['playbook'], [...path, 'bulkActions', i, 'playbook']), a.forEach.inputs, [...path, 'bulkActions', i, 'forEach', 'inputs']),
        );
      }
      def.actions?.forEach((a, i) => {
        if (a.playbook) checkInputs(find(a.playbook, ['playbook', 'runbook'], ['actions', i, 'playbook']), a.inputs, ['actions', i, 'inputs']);
      });
    }

    if (def.kind === 'playbook' || def.kind === 'runbook') {
      const checkAction = (s: Step | Compensation, path: PathSegment[], mode: 'read' | 'write') => {
        if (s.type === 'function') {
          const op = connectionOp(s.connection, s.operation, path);
          if (op?.mode === 'write' && mode !== 'write') err([...path, 'mode'], `Operation "${s.operation}" is mode: write; declare mode: write.`);
        }
        if (s.type === 'playbook') {
          const child = find(s.ref, ['playbook'], [...path, 'ref']);
          checkInputs(child, s.inputs, [...path, 'inputs']);
          if (child?.kind === 'playbook' && child.mode === 'write' && def.mode !== 'write')
            err([...path, 'ref'], `Child playbook "${s.ref}" writes; set the top-level mode: write.`);
        }
      };
      const groups: Array<{ steps: Step[]; path: PathSegment[] }> =
        def.kind === 'playbook' ? [{ steps: def.steps, path: ['steps'] }] : def.sections.map((s, i) => ({ steps: s.steps ?? [], path: ['sections', i, 'steps'] }));
      for (const g of groups)
        walkSteps(
          g.steps,
          (step, path) => {
            checkAction(step, path, stepMode(step));
            if (step.compensate) checkAction(step.compensate, [...path, 'compensate'], 'write');
          },
          g.path,
        );
    }

    if (def.kind === 'schedule') {
      const job = def.job;
      if (job.kind === 'report') {
        const report = find(job.ref, ['report'], ['job', 'ref']);
        if (report?.kind === 'report')
          for (const key of Object.keys(job.params ?? {}))
            if (!report.params || !(key in report.params)) err(['job', 'params', key], `Report "${job.ref}" has no param "${key}".`);
      } else if (job.kind === 'playbook') {
        const pb = find(job.ref, ['playbook'], ['job', 'ref']);
        checkInputs(pb, job.inputs, ['job', 'inputs']);
        if (pb?.kind === 'playbook' && pb.mode !== job.mode) err(['job', 'mode'], `Playbook "${job.ref}" is mode: ${pb.mode}; the job must say mode: ${pb.mode}.`);
      } else if (job.kind === 'probe') {
        if (job.ref) find(job.ref, ['probe'], ['job', 'ref']);
        job.refs?.forEach((ref, i) => find(ref, ['probe'], ['job', 'refs', i]));
        if (job.select) {
          const tags = job.select.tags;
          const hit = entries.some((e) => e.def.kind === 'probe' && tags.every((t) => e.def.tags?.includes(t)));
          if (!hit) err(['job', 'select', 'tags'], `No probe has all of the tags ${tags.join(', ')}.`);
        }
      }
    }

    if (def.kind === 'probe') {
      const c = def.check;
      if (c.kind === 'functionHealth') {
        const conn = find(c.connection, ['connection'], ['check', 'connection']) as Connection | undefined;
        const op = c.operation ?? conn?.health;
        if (conn && !op) err(['check', 'operation'], `Connection "${c.connection}" has no health operation; set check.operation.`);
        else if (conn && op && !conn.operations[op]) err(['check', 'operation'], `Connection "${c.connection}" has no operation "${op}".`);
      }
      if (c.kind === 'tokenAcquisition' && c.connection) find(c.connection, ['connection'], ['check', 'connection']);
    }
  }
  return errors;
}
