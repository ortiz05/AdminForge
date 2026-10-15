import { evaluate, ExpressionError, type EvaluateOptions, type Scope } from './evaluate';
import { hasTemplate, splitTemplate, TemplateError, wholeExpression } from './template';

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function interpolate(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/** Renders one string: a whole `${ … }` keeps its type; mixed text interpolates to a string. */
export async function renderString(str: string, scope: Scope, opts: EvaluateOptions = {}): Promise<unknown> {
  if (!hasTemplate(str)) return str;
  let segments;
  try {
    segments = splitTemplate(str);
  } catch (err) {
    if (err instanceof TemplateError) throw new ExpressionError(err.message, str, 'TEMPLATE', err.position);
    throw err;
  }
  const whole = wholeExpression(segments);
  if (whole !== undefined) return evaluate(whole, scope, opts);
  let out = '';
  for (const seg of segments) out += seg.type === 'text' ? seg.value : interpolate(await evaluate(seg.source, scope, opts));
  return out;
}

async function render(value: unknown, scope: Scope, opts: EvaluateOptions, path: string): Promise<unknown> {
  try {
    if (typeof value === 'string') return await renderString(value, scope, opts);
  } catch (err) {
    if (err instanceof ExpressionError && err.path === undefined) err.path = path;
    throw err;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i++) out.push(await render(value[i], scope, opts, `${path}[${i}]`));
    return out;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = await render(v, scope, opts, path ? `${path}.${k}` : k);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

/**
 * Deep-renders strings inside objects and arrays. Keys whose value renders to `undefined` are dropped.
 * Errors are ExpressionError with `path` set to where the failing template sits.
 */
export async function renderTemplate<T = unknown>(value: unknown, scope: Scope, opts: EvaluateOptions = {}): Promise<T> {
  return (await render(value, scope, opts, '')) as T;
}
