/**
 * What a person sees when a datasource expression fails while their page loads (D-19c, CLAUDE.md rule 10).
 *
 * JSONata's own messages are written for the expression's author ("T2001: The left side of the + operator must
 * evaluate to a number") and can quote the data they tripped over ("Unable to cast value to a number: "avery@…"").
 * The message says in plain words what went wrong, from the JSONata error code; where it sits — the expression's path
 * in the definition and the code — goes in `detail` and in the service log under the reference, never in the message.
 * The log line keeps codes and paths only: no JSONata message, no data.
 */
import { ExpressionError } from '@adminforge/expressions';

/** Plain sentences by JSONata error code (https://github.com/jsonata-js/jsonata/blob/master/src/utils.js codes). */
const BY_CODE: ReadonlyArray<[RegExp, string]> = [
  [/^(S0[1-5]\d\d|TEMPLATE)$/, 'this page’s definition has an expression AdminForge can’t read'],
  [/^T04(10|11|12)$/, 'a function in this page’s definition was given the wrong kind of value'],
  [/^T(1005|1006|1007|1008|2006)$/, 'this page’s definition calls a function that doesn’t exist'],
  [/^T200[12]$/, 'a calculation in this page’s definition met a value that isn’t a number'],
  [/^(T200[34]|D2014)$/, 'a range in this page’s definition isn’t made of whole numbers, or is too long'],
  [/^T200[78]$/, 'this page’s definition sorts values that can’t be compared with each other'],
  [/^T20(09|10)$/, 'this page’s definition compares values of different kinds, such as text with a number'],
  [/^(T1003|D1009)$/, 'this page’s definition builds a record with a missing or repeated field name'],
  [/^T201[123]$/, 'a transform in this page’s definition can’t change this data'],
  [/^D3030$/, 'this page’s definition expects a number where the data has text'],
  [/^(D1001|D1002|D3001|D306[01])$/, 'a calculation in this page’s definition went out of range'],
  [/^(D1004|D301[0-2]|D3020|D3040)$/, 'a text pattern in this page’s definition doesn’t fit this data'],
  [/^D313[89]$/, 'this page’s definition expected exactly one matching item'],
  [/^(D3110|D313\d|D308\d)$/, 'the data has a date, time or number format this page’s definition can’t read'],
  [/^D1011$/, 'preparing this data needed more steps than AdminForge allows'],
];

/** Helper failures carry no code; their message starts with the helper's name (`$guid: not a valid GUID: …`). */
const BY_HELPER: ReadonlyArray<[RegExp, string]> = [
  [/^\$guid:/, 'a value that should be an object ID isn’t one'],
  [/^\$(encode|odata|odataSearch|kql):/, 'a value this page needs is missing or isn’t text'],
  [/^\$/, 'a function in this page’s definition refused a value'],
  [/^The result is too large/, 'the result is too large to prepare'],
];

export interface ExpressionFailure {
  message: string;
  hint: string;
  /** `datasources.<name>.<what>[.<path inside it>] (<code>)`: where it failed, for the content author. */
  detail: string;
  /** For the log line: the expression's path in the definition and the JSONata code (or `none`). */
  log: { expression: string; code: string; position?: number };
}

/**
 * The copy for an expression that failed in datasource `datasource` (`what`: when, data, request, requests,
 * parameters, transform). `err` is whatever the evaluation threw.
 */
export function expressionFailure(err: unknown, datasource: string, what: string): ExpressionFailure {
  const e = err instanceof ExpressionError ? err : undefined;
  const code = e?.code ?? 'none';
  const reason = e?.reason ?? (err instanceof Error ? err.message : '');
  const sentence =
    (e?.code ? BY_CODE.find(([re]) => re.test(code))?.[1] : BY_HELPER.find(([re]) => re.test(reason))?.[1]) ??
    'this page’s definition didn’t work with the data it got';
  const expression = [`datasources.${datasource}.${what}`, e?.path].filter(Boolean).join('.');
  return {
    message: `AdminForge couldn’t prepare this data: ${sentence}.`,
    hint: 'Tell a Portal Admin which page this was and give them the reference below. For the content author: the details name the expression that failed and its JSONata code.',
    detail: `${expression} (${code})`,
    log: { expression, code, ...(e?.position !== undefined ? { position: e.position } : {}) },
  };
}
