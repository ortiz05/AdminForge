/**
 * Static type analysis of the output columns of a Resource Graph (KQL) query, for content tests.
 *
 * Azure Resource Graph returns a COMPUTED boolean column (a comparison, `in`/`contains`, `isnotempty()`, `tobool()`,
 * `coalesce(…, false)`, `iff(c, true, false)`, …) as 1/0 in `objectArray` results, and `tostring()` of one gives
 * "True"/"False". Only a raw property passed through untouched (`properties.enabled`) keeps its JSON true/false.
 * Content therefore projects flags as text with `iff(cond, 'true', 'false')`.
 *
 * `analyzeKql()` classifies each output column as:
 *   - `bool`      a computed boolean — arrives as 1/0, never as true/false;
 *   - `flagText`  `iff(cond, 'true', 'false')` (or another expression that only yields those two strings);
 *   - `other`     anything else (strings, numbers, dates, raw properties, dynamic).
 *
 * It is a heuristic, not a KQL parser: `${ … }` template fragments are ignored, and only `extend`, `project`,
 * `summarize`, `join`/`union` sub-queries, `mv-expand`, `distinct` and `project-away`/`project-rename` change columns.
 */
export type ColumnType = 'bool' | 'flagText' | 'other';

export interface KqlColumns {
  /** Type of every column the query names, in pipeline order (sub-queries included). */
  columns: Map<string, ColumnType>;
  /** Output columns when a `project`/`summarize`/`distinct` fixes them; null when the source table's columns pass through. */
  outputs: string[] | null;
}

const OPEN = '([{';
const CLOSE = ')]}';

/** Drops `${ … }` template fragments (they may hold nested braces and quoted strings). */
function stripTemplates(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '$' && s[i + 1] === '{') {
      let depth = 0;
      let quote = '';
      let j = i + 1;
      for (; j < s.length; j++) {
        const c = s[j]!;
        if (quote) {
          if (c === '\\') j++;
          else if (c === quote) quote = '';
          continue;
        }
        if (c === "'" || c === '"') quote = c;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
      }
      i = j;
      continue;
    }
    out += s[i];
  }
  return out;
}

/** Template fragments and comments removed; every string literal becomes 'true', 'false' or 's'. */
export function skeleton(kql: string): string {
  const s = stripTemplates(kql);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    const verbatim = c === '@' && (s[i + 1] === "'" || s[i + 1] === '"');
    if (c === "'" || c === '"' || verbatim) {
      const q = verbatim ? s[i + 1]! : c;
      let j = verbatim ? i + 2 : i + 1;
      let text = '';
      for (; j < s.length; j++) {
        if (!verbatim && s[j] === '\\') {
          text += s[j + 1] ?? '';
          j++;
          continue;
        }
        if (s[j] === q) break;
        text += s[j];
      }
      out += text === 'true' || text === 'false' ? `'${text}'` : "'s'";
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}

/** Splits on `sep` outside brackets (strings are already reduced by `skeleton`). */
export function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The expression with everything inside brackets removed: only its top level is left. */
function topLevel(e: string): string {
  let depth = 0;
  let out = '';
  for (const c of e) {
    if (CLOSE.includes(c)) depth--;
    if (depth === 0) out += c;
    if (OPEN.includes(c)) depth++;
  }
  return out;
}

/** `fn(args)` when the whole expression is one call. */
function asCall(e: string): { fn: string; args: string[] } | null {
  const m = /^([A-Za-z_][\w]*)\s*\(/.exec(e);
  if (!m) return null;
  let depth = 0;
  for (let i = m[0].length - 1; i < e.length; i++) {
    if (OPEN.includes(e[i]!)) depth++;
    else if (CLOSE.includes(e[i]!) && --depth === 0)
      return i === e.length - 1
        ? { fn: m[1]!.toLowerCase(), args: splitTop(e.slice(m[0].length, i), ',') }
        : null;
  }
  return null;
}

const COMPARISON = /==|!=|=~|!~|<=|>=|<|>/;
const WORD_OPERATOR =
  /(^|[\s)])(and|or|!?in~?|!?contains(_cs)?|!?has(_cs|_any|_all|prefix|suffix)?(_cs)?|!?startswith(_cs)?|!?endswith(_cs)?|matches\s+regex|!?between|!?like)(?=[\s(]|$)/i;
const BOOL_FUNCTIONS = new Set([
  'tobool',
  'toboolean',
  'isnotempty',
  'isempty',
  'isnull',
  'isnotnull',
  'not',
  'isnan',
  'isinf',
  'isfinite',
  'set_has_element',
  'bag_has_key',
  'ipv4_is_private',
  'ipv4_is_in_range',
  'ipv4_is_match',
  'has_ipv4',
  'has_ipv4_prefix',
  'isascii',
  'isutf8',
]);
/** Functions whose result has the type of the listed arguments. */
const PASS_THROUGH: Record<string, (args: string[]) => string[]> = {
  coalesce: (a) => a,
  iff: (a) => a.slice(1, 3),
  iif: (a) => a.slice(1, 3),
  case: (a) => a.filter((_, i) => i % 2 === 1 || i === a.length - 1),
  any: (a) => a.slice(0, 1),
  anyif: (a) => a.slice(0, 1),
  take_any: (a) => a.slice(0, 1),
  take_anyif: (a) => a.slice(0, 1),
  max: (a) => a.slice(0, 1),
  min: (a) => a.slice(0, 1),
  maxif: (a) => a.slice(0, 1),
  minif: (a) => a.slice(0, 1),
};

export function classify(expr: string, columns: Map<string, ColumnType>): ColumnType {
  let e = expr.trim();
  // (a == b) → a == b
  while (e.startsWith('(') && asCall(`f${e}`)) e = e.slice(1, -1).trim();
  if (e === 'true' || e === 'false') return 'bool';
  if (e === "'true'" || e === "'false'") return 'flagText';
  if (/^[A-Za-z_]\w*$/.test(e)) return columns.get(e) ?? 'other';
  const top = topLevel(e);
  if (COMPARISON.test(top) || WORD_OPERATOR.test(top)) return 'bool';
  const call = asCall(e);
  if (!call) return 'other';
  if (BOOL_FUNCTIONS.has(call.fn)) return 'bool';
  const pick = PASS_THROUGH[call.fn];
  if (!pick) return 'other';
  const branches = pick(call.args)
    .filter((a) => a !== 'null' && !/^bool\(\s*null\s*\)$/.test(a))
    .map((a) => classify(a, columns));
  if (!branches.length) return 'other';
  if (branches.every((t) => t === 'bool')) return 'bool';
  if (branches.every((t) => t === 'flagText')) return 'flagText';
  return 'other';
}

/** `name = expr` or a bare column name; unnamed expressions get KQL's default-ish names. */
function item(text: string): { name: string; expr: string } | null {
  const m = /^([A-Za-z_]\w*)\s*=(?![=~])\s*([\s\S]+)$/.exec(text);
  if (m) return { name: m[1]!, expr: m[2]! };
  if (/^[A-Za-z_]\w*$/.test(text)) return { name: text, expr: text };
  const call = asCall(text);
  return call ? { name: `${call.fn}_`, expr: text } : null;
}

function analyzeSkeleton(sk: string): KqlColumns {
  const columns = new Map<string, ColumnType>();
  let outputs: string[] | null = null;
  const add = (names: string[]) => {
    if (outputs) outputs = [...outputs, ...names.filter((n) => !outputs!.includes(n))];
  };
  const assign = (items: string[], replace: boolean) => {
    const names: string[] = [];
    for (const raw of items) {
      const it = item(raw);
      if (!it) continue;
      columns.set(it.name, classify(it.expr, columns));
      names.push(it.name);
    }
    if (replace) outputs = names;
    else add(names);
  };
  const subquery = (rest: string) => {
    const open = rest.indexOf('(');
    if (open < 0) return;
    let depth = 0;
    for (let i = open; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')' && --depth === 0) {
        const sub = analyzeSkeleton(rest.slice(open + 1, i));
        for (const [k, v] of sub.columns) if (!columns.has(k)) columns.set(k, v);
        add(sub.outputs ?? [...sub.columns.keys()]);
        return;
      }
    }
  };
  for (const stage of splitTop(sk, '|')) {
    const m = /^([a-z][a-z-]*)\b\s*([\s\S]*)$/i.exec(stage);
    if (!m) continue;
    const op = m[1]!.toLowerCase();
    const rest = m[2]!;
    if (op === 'extend') assign(splitTop(rest, ','), false);
    else if (op === 'project') assign(splitTop(rest, ','), true);
    else if (op === 'distinct') assign(splitTop(rest, ','), true);
    else if (op === 'summarize') {
      // The ` by ` that starts the group keys, outside any brackets.
      let at = -1;
      for (let i = 0, depth = 0; i < rest.length && at < 0; i++) {
        const c = rest[i]!;
        if (OPEN.includes(c)) depth++;
        else if (CLOSE.includes(c)) depth--;
        else if (depth === 0 && i > 0 && /\sby\s/.test(rest.slice(i - 1, i + 3))) at = i;
      }
      const aggs = at < 0 ? rest : rest.slice(0, at);
      const keys = at < 0 ? '' : rest.slice(at + 2);
      assign([...splitTop(aggs, ','), ...splitTop(keys, ',')], true);
    } else if (op === 'join' || op === 'union' || op === 'lookup') subquery(rest);
    else if (op === 'mv-expand') {
      const it = item(splitTop(rest.replace(/\bto\s+typeof\([^)]*\)/g, ''), ',')[0] ?? '');
      if (it) {
        columns.set(it.name, 'other');
        add([it.name]);
      }
    } else if (op === 'project-away' && outputs) {
      const away = splitTop(rest, ',');
      outputs = (outputs as string[]).filter((n) => !away.includes(n));
    } else if (op === 'project-rename')
      for (const raw of splitTop(rest, ',')) {
        const it = item(raw);
        if (!it) continue;
        columns.set(it.name, columns.get(it.expr.trim()) ?? 'other');
        if (outputs) outputs = (outputs as string[]).map((n) => (n === it.expr.trim() ? it.name : n));
      }
  }
  return { columns, outputs };
}

/** Column types of a Resource Graph query (content form: `${ … }` fragments are ignored). */
export function analyzeKql(kql: string): KqlColumns {
  return analyzeSkeleton(skeleton(kql));
}

/** Output columns of the query that hold the given type. */
export function outputColumns(kql: string, type: ColumnType): string[] {
  const { columns, outputs } = analyzeKql(kql);
  return (outputs ?? [...columns.keys()]).filter((n) => columns.get(n) === type);
}
