import { compile, ExpressionError } from './evaluate';
import { hasTemplate, splitTemplate, TemplateError } from './template';

export type PathSegment = string | number;

export interface ExpressionIssue {
  /** Dotted path, e.g. `steps[1].request.path`. */
  path: string;
  segments: PathSegment[];
  /** The template or expression text that failed. */
  expression: string;
  message: string;
  position?: number;
}

export interface WalkOptions {
  /** Return true to skip a subtree. Default: skips top-level `tests` (literal test data) and `$schema`. */
  skip?: (segments: readonly PathSegment[]) => boolean;
}

const defaultSkip = (s: readonly PathSegment[]) => s.length === 1 && (s[0] === 'tests' || s[0] === '$schema');

export function formatPath(segments: readonly PathSegment[]): string {
  return segments.reduce<string>(
    (out, seg) => (typeof seg === 'number' ? `${out}[${seg}]` : /^[A-Za-z_$][\w$-]*$/.test(seg) ? (out ? `${out}.${seg}` : seg) : `${out}[${JSON.stringify(seg)}]`),
    '',
  );
}

/** Visits every string in a definition with its path. */
function walkStrings(value: unknown, visit: (s: string, segments: PathSegment[]) => void, opts: WalkOptions, segments: PathSegment[] = []): void {
  if ((opts.skip ?? defaultSkip)(segments)) return;
  if (typeof value === 'string') visit(value, segments);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, opts, [...segments, i]));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, visit, opts, [...segments, k]);
}

/** Compiles every `${ … }` in a definition and reports the ones that are malformed. Empty array = all good. */
export function validateExpressions(def: unknown, opts: WalkOptions = {}): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  walkStrings(
    def,
    (str, segments) => {
      if (!hasTemplate(str)) return;
      const at = { path: formatPath(segments), segments };
      try {
        for (const seg of splitTemplate(str)) {
          if (seg.type !== 'expr') continue;
          try {
            compile(seg.source);
          } catch (err) {
            const e = err as ExpressionError;
            issues.push({ ...at, expression: seg.source, message: e.reason ?? e.message, position: e.position });
          }
        }
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        issues.push({ ...at, expression: str, message: err.message, position: err.position });
      }
    },
    opts,
  );
  return issues;
}

/** Every expression source in a definition (useful for reference scans such as `env.X`). */
export function collectExpressions(def: unknown, opts: WalkOptions = {}): Array<{ path: string; source: string }> {
  const out: Array<{ path: string; source: string }> = [];
  walkStrings(
    def,
    (str, segments) => {
      if (!hasTemplate(str)) return;
      try {
        for (const seg of splitTemplate(str)) if (seg.type === 'expr') out.push({ path: formatPath(segments), source: seg.source });
      } catch {
        // malformed templates are reported by validateExpressions
      }
    },
    opts,
  );
  return out;
}

const USER_DATA_ROOTS = new Set(['params', 'inputs', 'row', 'rows', 'item', 'value']);
type AstNode = { type?: string; value?: unknown; steps?: AstNode[] } & Record<string, unknown>;

const isUserData = (n: AstNode | undefined): boolean =>
  !!n &&
  ((n.type === 'name' && USER_DATA_ROOTS.has(String(n.value))) ||
    (n.type === 'path' && n.steps?.[0]?.type === 'name' && USER_DATA_ROOTS.has(String(n.steps[0].value))));

function rawConcat(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const n = node as AstNode;
  if (n.type === 'binary' && n.value === '&' && (isUserData(n.lhs as AstNode) || isUserData(n.rhs as AstNode))) return true;
  return Object.values(n).some((v) => (Array.isArray(v) ? v.some(rawConcat) : typeof v === 'object' && rawConcat(v)));
}

/**
 * Lint (§5.10, §7.9): user data concatenated into `$filter` / `$search` without `$odata()` / `$odataSearch()`.
 * Returns warnings; expressions that do not compile are skipped (validateExpressions reports them).
 */
export function lintExpressions(def: unknown, opts: WalkOptions = {}): ExpressionIssue[] {
  const issues: ExpressionIssue[] = [];
  walkStrings(
    def,
    (str, segments) => {
      const key = segments[segments.length - 1];
      if (!hasTemplate(str) || (key !== '$filter' && key !== '$search')) return;
      try {
        for (const seg of splitTemplate(str)) {
          if (seg.type !== 'expr') continue;
          let ast: unknown;
          try {
            ast = compile(seg.source).ast();
          } catch {
            continue;
          }
          if (rawConcat(ast))
            issues.push({
              path: formatPath(segments),
              segments,
              expression: seg.source,
              message: `User data is concatenated into ${key} without ${key === '$filter' ? '$odata()' : '$odataSearch()'}.`,
            });
        }
      } catch {
        // malformed templates are reported by validateExpressions
      }
    },
    opts,
  );
  return issues;
}
