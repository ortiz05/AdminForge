import { renderString, type Scope } from '@adminforge/expressions';
import { checkParam, type DateRangeValue, type Params } from '@adminforge/schemas';
import { AppError } from '../errors';

export interface ParamIssue {
  param: string;
  message: string;
}

/** 400 with every problem listed (the client renders them next to the filter controls). */
export class InvalidParams extends AppError {
  constructor(
    readonly issues: ParamIssue[],
    hint = 'Check the filter values and try again.',
  ) {
    super(
      400,
      'invalid_params',
      `Invalid parameters: ${issues.map((i) => `${i.param}: ${i.message}`).join('; ')}`,
      { hint },
    );
    this.name = 'InvalidParams';
  }
}

// The checks are shared with the browser (`@adminforge/schemas` › param-check) so a link the page reports as fine is
// one the API accepts; these re-exports keep the API's own importers (the query builder compiler) where they were.
export { resolveDate, type DateRangeValue } from '@adminforge/schemas';

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Validates page params against their declarations (§7.3) and fills defaults. Unknown names are rejected; values are
 * coerced the way URLs deliver them ("30" → 30, "true" → true). `default` expressions see `now`, `user` and `env`.
 */
export async function resolveParams(
  declared: Params | undefined,
  input: Record<string, unknown> | undefined,
  scope: Scope & { now: string },
): Promise<Record<string, unknown>> {
  const decl = declared ?? {};
  const raw = input ?? {};
  const now = new Date(scope.now);
  const issues: ParamIssue[] = [];
  for (const name of Object.keys(raw))
    if (!Object.hasOwn(decl, name)) issues.push({ param: name, message: 'unknown parameter' });
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(decl)) {
    let v: unknown = Object.hasOwn(raw, name) ? raw[name] : undefined;
    if (isEmpty(v) && p.default !== undefined) {
      v = p.default;
      if (typeof v === 'string' && v.includes('${')) {
        try {
          v = await renderString(v, scope);
        } catch (err) {
          issues.push({ param: name, message: `default could not be evaluated: ${(err as Error).message}` });
          continue;
        }
      }
    }
    if (isEmpty(v)) {
      if (p.required) issues.push({ param: name, message: 'is required' });
      // Text params keep "" so expressions can test them (`params.q ? …`).
      if (p.type === 'string' && v === '') out[name] = '';
      continue;
    }
    const checked = checkParam(p, v, now);
    if ('error' in checked) issues.push({ param: name, message: checked.error });
    else out[name] = checked.value;
  }
  if (issues.length) throw new InvalidParams(issues);
  return out;
}

/** The first date-range param's interval (default Log Analytics timespan), if any. */
export function defaultTimespan(
  declared: Params | undefined,
  values: Record<string, unknown>,
): string | undefined {
  for (const [name, p] of Object.entries(declared ?? {})) {
    if (p.type !== 'dateRange') continue;
    const v = values[name] as DateRangeValue | undefined;
    if (v?.timespan) return v.timespan;
  }
  return undefined;
}
