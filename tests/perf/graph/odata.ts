/**
 * The OData subset AdminForge content sends to Microsoft Graph, evaluated the way Graph does, for the fake Graph
 * (fake-graph.ts). Anything outside the subset throws `ODataError` (answered 400) — the fake must never quietly return
 * everything for a query it didn't understand.
 *
 * $filter: eq ne gt ge lt le, and / or / not, parentheses, `in (…)`, startswith / endswith, `any` / `all` lambdas over
 * collections (`assignedLicenses/any(l: l/skuId eq <guid>)`, `proxyAddresses/any(p: startswith(p, 'smtp:'))`), property
 * paths (`signInActivity/lastSignInDateTime`), `<relation>/$count` (`owners/$count eq 0`), literals: 'strings' ('' to
 * escape), numbers, true/false/null, GUIDs and date-times unquoted, enum literals (`microsoft.graph.riskState'atRisk'`).
 * String comparison is case-insensitive, as on directory objects.
 *
 * `needsAdvanced` marks what Graph only accepts as an advanced query on directory objects (ne, not, endswith,
 * `/$count` in a filter): ConsistencyLevel: eventual and $count=true, otherwise 400.
 */

export class ODataError extends Error {
  constructor(
    message: string,
    readonly code = 'BadRequest',
  ) {
    super(message);
  }
}

type Value = string | number | boolean | null;
export type Expr =
  | { t: 'lit'; v: Value }
  | { t: 'path'; segs: string[] }
  | { t: 'cmp'; op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le'; l: Expr; r: Expr }
  | { t: 'and' | 'or'; l: Expr; r: Expr }
  | { t: 'not'; e: Expr }
  | { t: 'in'; l: Expr; list: Value[] }
  | { t: 'fn'; name: 'startswith' | 'endswith' | 'contains'; args: Expr[] }
  | { t: 'lambda'; kind: 'any' | 'all'; coll: string[]; v: string; body: Expr | null }
  | { t: 'count'; coll: string[] };

export interface Filter {
  expr: Expr;
  needsAdvanced: boolean;
  /** For time-ordered collections: bounds on a time field from top-level `and` conjuncts. */
  bounds: Map<string, { from?: number; to?: number }>;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?/;

type Tok = { k: 'id' | 'str' | 'num' | 'guid' | 'date' | 'punc' | 'enum'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if ('(),:'.includes(c)) {
      out.push({ k: 'punc', v: c });
      i++;
      continue;
    }
    if (c === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new ODataError(`Unterminated string literal in $filter: ${src}`);
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ k: 'str', v: s });
      continue;
    }
    const rest = src.slice(i);
    const g = GUID.exec(rest);
    if (g && !/[\w-]/.test(rest[g[0].length] ?? '')) {
      out.push({ k: 'guid', v: g[0].toLowerCase() });
      i += g[0].length;
      continue;
    }
    const d = DATETIME.exec(rest);
    if (d && d[0].length >= 10 && /^\d{4}-/.test(rest)) {
      out.push({ k: 'date', v: d[0] });
      i += d[0].length;
      continue;
    }
    const n = /^-?\d+(\.\d+)?/.exec(rest);
    if (n) {
      out.push({ k: 'num', v: n[0] });
      i += n[0].length;
      continue;
    }
    const id = /^[A-Za-z_$@][\w$@.]*(\/[A-Za-z_$@][\w$@.]*)*/.exec(rest);
    if (id) {
      i += id[0].length;
      // enum literal: microsoft.graph.riskState'atRisk'
      if (src[i] === "'" && id[0].includes('.')) {
        const end = src.indexOf("'", i + 1);
        if (end < 0) throw new ODataError(`Unterminated enum literal in $filter: ${src}`);
        out.push({ k: 'enum', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      out.push({ k: 'id', v: id[0] });
      continue;
    }
    throw new ODataError(`Unsupported character '${c}' in $filter: ${src}`);
  }
  return out;
}

const CMP = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le']);

export function parseFilter(src: string): Filter {
  const toks = lex(src);
  let p = 0;
  let needsAdvanced = false;
  const peek = () => toks[p];
  const isWord = (w: string) => peek()?.k === 'id' && peek()!.v.toLowerCase() === w;
  const expect = (v: string) => {
    const t = toks[p++];
    if (!t || t.v !== v) throw new ODataError(`Expected '${v}' in $filter: ${src}`);
  };
  const literal = (t: Tok): Value => {
    if (t.k === 'str' || t.k === 'guid' || t.k === 'date' || t.k === 'enum') return t.v;
    if (t.k === 'num') return Number(t.v);
    if (t.k === 'id') {
      const w = t.v.toLowerCase();
      if (w === 'true') return true;
      if (w === 'false') return false;
      if (w === 'null') return null;
    }
    throw new ODataError(`Expected a literal, got '${t.v}' in $filter: ${src}`);
  };
  const lambdaVars: string[] = [];

  const primary = (): Expr => {
    const t = peek();
    if (!t) throw new ODataError(`Unexpected end of $filter: ${src}`);
    if (t.v === '(' && t.k === 'punc') {
      p++;
      const e = orExpr();
      expect(')');
      return e;
    }
    if (t.k === 'id') {
      const w = t.v.toLowerCase();
      if (w === 'not') {
        p++;
        needsAdvanced = true;
        return { t: 'not', e: primary() };
      }
      if (['true', 'false', 'null'].includes(w)) {
        p++;
        return { t: 'lit', v: literal(t) };
      }
      if (toks[p + 1]?.v === '(' && ['startswith', 'endswith', 'contains'].includes(w)) {
        p += 2;
        const args: Expr[] = [operand()];
        while (peek()?.v === ',') {
          p++;
          args.push(operand());
        }
        expect(')');
        if (w === 'endswith') needsAdvanced = true;
        if (w === 'contains')
          throw new ODataError(
            `contains() is not supported for this property: ${src}`,
            'Request_UnsupportedQuery',
          );
        return { t: 'fn', name: w as 'startswith' | 'endswith', args };
      }
      const segs = t.v.split('/');
      const last = segs[segs.length - 1]!.toLowerCase();
      if ((last === 'any' || last === 'all') && toks[p + 1]?.v === '(') {
        p += 2;
        if (peek()?.v === ')') {
          p++;
          return { t: 'lambda', kind: last, coll: segs.slice(0, -1), v: '', body: null };
        }
        const v = toks[p++];
        if (!v || v.k !== 'id') throw new ODataError(`Expected a lambda variable in $filter: ${src}`);
        expect(':');
        lambdaVars.push(v.v);
        const body = orExpr();
        lambdaVars.pop();
        expect(')');
        return { t: 'lambda', kind: last, coll: segs.slice(0, -1), v: v.v, body };
      }
      p++;
      if (last === '$count') {
        needsAdvanced = true;
        return { t: 'count', coll: segs.slice(0, -1) };
      }
      return { t: 'path', segs };
    }
    p++;
    return { t: 'lit', v: literal(t) };
  };
  const operand = (): Expr => primary();
  const comparison = (): Expr => {
    const l = primary();
    if (peek()?.k === 'id' && CMP.has(peek()!.v.toLowerCase())) {
      const op = toks[p++]!.v.toLowerCase() as 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le';
      if (op === 'ne') needsAdvanced = true;
      const r = primary();
      return { t: 'cmp', op, l, r };
    }
    if (isWord('in')) {
      p++;
      expect('(');
      const list: Value[] = [];
      for (;;) {
        const t = toks[p++];
        if (!t) throw new ODataError(`Unterminated in (…) in $filter: ${src}`);
        list.push(literal(t));
        if (peek()?.v === ',') {
          p++;
          continue;
        }
        break;
      }
      expect(')');
      return { t: 'in', l, list };
    }
    return l;
  };
  const andExpr = (): Expr => {
    let l = comparison();
    while (isWord('and')) {
      p++;
      l = { t: 'and', l, r: comparison() };
    }
    return l;
  };
  const orExpr = (): Expr => {
    let l = andExpr();
    while (isWord('or')) {
      p++;
      l = { t: 'or', l, r: andExpr() };
    }
    return l;
  };
  const expr = orExpr();
  if (p !== toks.length) throw new ODataError(`Unexpected '${toks[p]!.v}' in $filter: ${src}`);

  const bounds = new Map<string, { from?: number; to?: number }>();
  const collect = (e: Expr) => {
    if (e.t === 'and') {
      collect(e.l);
      collect(e.r);
    } else if (e.t === 'cmp' && e.l.t === 'path' && e.r.t === 'lit' && typeof e.r.v === 'string') {
      const ms = Date.parse(e.r.v);
      if (!Number.isFinite(ms) || !/^\d{4}-/.test(e.r.v)) return;
      const key = e.l.segs.join('/');
      const b = bounds.get(key) ?? {};
      if (e.op === 'ge' || e.op === 'gt') b.from = Math.max(b.from ?? -Infinity, ms);
      if (e.op === 'le' || e.op === 'lt') b.to = Math.min(b.to ?? Infinity, ms);
      bounds.set(key, b);
    }
  };
  collect(expr);
  return { expr, needsAdvanced, bounds };
}

type Obj = Record<string, unknown>;
export interface EvalContext {
  /** `<relation>/$count` of an object (owners/$count): undefined when the relation isn't modelled. */
  count?: (obj: Obj, relation: string) => number | undefined;
}

function resolve(obj: unknown, segs: string[], vars: Map<string, unknown>): unknown {
  let cur: unknown = obj;
  let start = 0;
  if (vars.has(segs[0]!)) {
    cur = vars.get(segs[0]!);
    start = 1;
  }
  for (let i = start; i < segs.length; i++) {
    if (cur === null || cur === undefined) return null;
    if (typeof cur !== 'object') return null;
    cur = (cur as Obj)[segs[i]!];
  }
  return cur === undefined ? null : cur;
}

const isDateLike = (s: string) => /^\d{4}-\d{2}-\d{2}/.test(s);
function compare(a: unknown, b: unknown): number | undefined {
  if (a === null || a === undefined || b === null || b === undefined) return undefined;
  if (typeof a === 'string' && typeof b === 'string') {
    if (isDateLike(a) && isDateLike(b)) return Date.parse(a) - Date.parse(b);
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).toLowerCase() === String(b).toLowerCase() ? 0 : undefined;
}

const eqLoose = (a: unknown, b: unknown) =>
  (a === null || a === undefined) && b === null ? true : compare(a, b) === 0;

export function evaluate(
  expr: Expr,
  obj: Obj,
  ctx: EvalContext = {},
  vars = new Map<string, unknown>(),
): unknown {
  switch (expr.t) {
    case 'lit':
      return expr.v;
    case 'path':
      return resolve(obj, expr.segs, vars);
    case 'count': {
      const n = ctx.count?.(obj, expr.coll.join('/'));
      if (n === undefined) {
        const v = resolve(obj, expr.coll, vars);
        if (Array.isArray(v)) return v.length;
        throw new ODataError(`${expr.coll.join('/')}/$count is not supported by the synthetic tenant`);
      }
      return n;
    }
    case 'cmp': {
      const a = evaluate(expr.l, obj, ctx, vars);
      const b = evaluate(expr.r, obj, ctx, vars);
      if (expr.op === 'eq') return eqLoose(a, b);
      if (expr.op === 'ne') return !eqLoose(a, b);
      const c = compare(a, b);
      if (c === undefined) return false;
      return expr.op === 'gt' ? c > 0 : expr.op === 'ge' ? c >= 0 : expr.op === 'lt' ? c < 0 : c <= 0;
    }
    case 'and':
      return evaluate(expr.l, obj, ctx, vars) === true && evaluate(expr.r, obj, ctx, vars) === true;
    case 'or':
      return evaluate(expr.l, obj, ctx, vars) === true || evaluate(expr.r, obj, ctx, vars) === true;
    case 'not':
      return evaluate(expr.e, obj, ctx, vars) !== true;
    case 'in': {
      const a = evaluate(expr.l, obj, ctx, vars);
      return expr.list.some((v) => eqLoose(a, v));
    }
    case 'fn': {
      const [x, y] = expr.args.map((e) => evaluate(e, obj, ctx, vars));
      if (typeof x !== 'string' || typeof y !== 'string') return false;
      const a = x.toLowerCase();
      const b = y.toLowerCase();
      return expr.name === 'startswith' ? a.startsWith(b) : a.endsWith(b);
    }
    case 'lambda': {
      const coll = resolve(obj, expr.coll, vars);
      const list = Array.isArray(coll) ? coll : [];
      if (!expr.body) return expr.kind === 'any' ? list.length > 0 : true;
      const test = (item: unknown) => {
        const next = new Map(vars);
        next.set(expr.v, item);
        return evaluate(expr.body!, obj, ctx, next) === true;
      };
      return expr.kind === 'any' ? list.some(test) : list.every(test);
    }
  }
}

/** `$search="displayName:foo" OR "mail:bar"` → terms; Graph matches word prefixes, case-insensitive. */
export function parseSearch(src: string): Array<Array<{ prop: string; term: string }>> {
  const groups: Array<Array<{ prop: string; term: string }>> = [[]];
  const re = /"([^"]*)"|\b(AND|OR)\b/g;
  let m: RegExpExecArray | null;
  let sawTerm = false;
  while ((m = re.exec(src))) {
    if (m[2] === 'OR') groups.push([]);
    else if (m[1] !== undefined) {
      const at = m[1].indexOf(':');
      if (at < 0) throw new ODataError(`$search needs "property:term" clauses: ${src}`);
      groups[groups.length - 1]!.push({ prop: m[1].slice(0, at), term: m[1].slice(at + 1).toLowerCase() });
      sawTerm = true;
    }
  }
  if (!sawTerm) throw new ODataError(`Unsupported $search: ${src}`);
  return groups.filter((g) => g.length);
}

export function matchesSearch(obj: Obj, search: Array<Array<{ prop: string; term: string }>>): boolean {
  return search.some((all) =>
    all.every(({ prop, term }) => {
      const v = obj[prop];
      if (typeof v !== 'string') return false;
      const lower = v.toLowerCase();
      if (lower.startsWith(term)) return true;
      return lower.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(term));
    }),
  );
}

export interface ExpandItem {
  name: string;
  select?: string[];
  top?: number;
  /** A nested $expand (kept as text; the fake returns the stored nested objects). */
  expand?: string;
}

/** `owners($select=id,displayName),manager` → items. */
export function parseExpand(src: string): ExpandItem[] {
  const items: ExpandItem[] = [];
  let depth = 0;
  let cur = '';
  const flush = () => {
    const s = cur.trim();
    cur = '';
    if (!s) return;
    const m = /^([\w.$/]+)(?:\((.*)\))?$/.exec(s);
    if (!m) throw new ODataError(`Unsupported $expand: ${src}`);
    const item: ExpandItem = { name: m[1]! };
    for (const opt of (m[2] ?? '').split(';').filter(Boolean)) {
      const [k, v] = opt.split('=');
      if (k === '$select') item.select = (v ?? '').split(',').filter(Boolean);
      else if (k === '$top') item.top = Number(v);
      else if (k === '$expand') item.expand = opt.slice('$expand='.length);
      else throw new ODataError(`Unsupported $expand option ${k}: ${src}`);
    }
    items.push(item);
  };
  for (const c of src) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) flush();
    else cur += c;
  }
  flush();
  return items;
}

/** `$orderby=displayName desc, createdDateTime` → a comparator. */
export function parseOrderBy(src: string): (a: Obj, b: Obj) => number {
  const keys = src.split(',').map((part) => {
    const [path, dir] = part.trim().split(/\s+/);
    if (!path || (dir && !/^(asc|desc)$/i.test(dir))) throw new ODataError(`Unsupported $orderby: ${src}`);
    return { segs: path.split('/'), desc: dir?.toLowerCase() === 'desc' };
  });
  return (a, b) => {
    for (const k of keys) {
      const x = resolve(a, k.segs, new Map());
      const y = resolve(b, k.segs, new Map());
      if (x === y) continue;
      if (x === null) return k.desc ? 1 : -1;
      if (y === null) return k.desc ? -1 : 1;
      const c = compare(x, y) ?? 0;
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  };
}

/** Keeps only `select` (plus id and @odata.type); unknown properties come back null, as Graph does for schema props. */
export function project(obj: Obj, select: string[] | undefined): Obj {
  if (!select) return obj;
  const out: Obj = {};
  if (obj['@odata.type'] !== undefined) out['@odata.type'] = obj['@odata.type'];
  if (obj.id !== undefined) out.id = obj.id;
  for (const s of select) out[s] = obj[s] === undefined ? null : obj[s];
  return out;
}
