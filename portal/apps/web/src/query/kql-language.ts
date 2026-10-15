import type { languages } from 'monaco-editor/editor/editor.api';

/**
 * A KQL-ish language for Monaco: Monarch highlighting plus static completions. Enough to read and write the
 * queries engineers run here (tabular operators, scalar/aggregation functions, string operators, literals);
 * not a parser — the service reports real syntax errors.
 */

export const KQL_LANGUAGE_ID = 'kql';

/** Tabular operators and clause words that follow them. */
export const KQL_KEYWORDS = [
  'where',
  'filter',
  'project',
  'extend',
  'summarize',
  'order',
  'sort',
  'by',
  'asc',
  'desc',
  'nulls',
  'first',
  'last',
  'take',
  'limit',
  'top',
  'count',
  'distinct',
  'join',
  'kind',
  'on',
  'union',
  'withsource',
  'lookup',
  'let',
  'as',
  'render',
  'evaluate',
  'parse',
  'with',
  'invoke',
  'search',
  'sample',
  'getschema',
  'serialize',
  'range',
  'from',
  'to',
  'step',
  'print',
  'datatable',
  'materialize',
  'toscalar',
  'facet',
  'fork',
  'consume',
  'externaldata',
  'inner',
  'innerunique',
  'leftouter',
  'rightouter',
  'fullouter',
  'leftanti',
  'rightanti',
  'leftsemi',
  'rightsemi',
  'anti',
  'semi',
  'true',
  'false',
  'null',
  'and',
  'or',
  'not',
  'in',
  'has',
  'has_any',
  'has_all',
  'hasprefix',
  'hassuffix',
  'contains',
  'contains_cs',
  'startswith',
  'startswith_cs',
  'endswith',
  'endswith_cs',
  'matches',
  'regex',
  'between',
  'like',
  'has_cs',
  'in~',
] as const;

/** Operators written with a dash (matched before plain words). */
export const KQL_DASHED = [
  'mv-expand',
  'mv-apply',
  'project-away',
  'project-keep',
  'project-rename',
  'project-reorder',
  'make-series',
  'top-nested',
  'top-hitters',
  'parse-where',
  'parse-kv',
] as const;

export const KQL_FUNCTIONS = [
  // aggregation
  'count',
  'countif',
  'dcount',
  'dcountif',
  'sum',
  'sumif',
  'avg',
  'avgif',
  'min',
  'max',
  'minif',
  'maxif',
  'arg_max',
  'arg_min',
  'make_set',
  'make_list',
  'make_bag',
  'take_any',
  'percentile',
  'percentiles',
  'stdev',
  'variance',
  // datetime
  'ago',
  'now',
  'bin',
  'bin_at',
  'startofday',
  'startofweek',
  'startofmonth',
  'endofday',
  'datetime',
  'timespan',
  'datetime_diff',
  'datetime_add',
  'format_datetime',
  'format_timespan',
  'dayofweek',
  'todatetime',
  'totimespan',
  'unixtime_seconds_todatetime',
  // conversion
  'tostring',
  'toint',
  'tolong',
  'todouble',
  'toreal',
  'tobool',
  'toguid',
  'todynamic',
  'parse_json',
  'todecimal',
  // string
  'strcat',
  'strcat_array',
  'strlen',
  'substring',
  'split',
  'tolower',
  'toupper',
  'trim',
  'trim_start',
  'trim_end',
  'replace_string',
  'replace_regex',
  'extract',
  'extract_all',
  'indexof',
  'reverse',
  'parse_url',
  'parse_path',
  'url_decode',
  'base64_decode_tostring',
  'countof',
  'strrep',
  'hash_sha256',
  // logic and dynamic
  'iff',
  'iif',
  'case',
  'coalesce',
  'isnull',
  'isnotnull',
  'isempty',
  'isnotempty',
  'array_length',
  'array_concat',
  'array_slice',
  'bag_keys',
  'bag_merge',
  'bag_pack',
  'pack',
  'pack_all',
  'set_difference',
  'set_union',
  'set_has_element',
  'round',
  'floor',
  'ceiling',
  'abs',
  'log10',
  'max_of',
  'min_of',
  'row_number',
  'prev',
  'next',
  'ipv4_is_private',
  'ipv4_is_in_range',
  'geo_info_from_ip_address',
] as const;

/** Monarch tokenizer. Token names map to theme rules in monaco-theme.ts. */
export function kqlMonarch(tables: readonly string[]): languages.IMonarchLanguage {
  return {
    defaultToken: '',
    ignoreCase: false,
    keywords: [...KQL_KEYWORDS],
    functions: [...KQL_FUNCTIONS],
    tables: [...tables],
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/@'(?:[^']|'')*'/, 'string'],
        [/@"(?:[^"]|"")*"/, 'string'],
        [/'(?:[^'\\]|\\.)*'/, 'string'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/'(?:[^'\\]|\\.)*$/, 'string.invalid'],
        [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
        [/\b\d+(?:\.\d+)?(?:d|h|m|s|ms|microseconds?|ticks?)\b/, 'number.timespan'],
        [/\b0x[0-9a-fA-F]+\b/, 'number'],
        [/\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b/, 'number'],
        [new RegExp(`\\b(?:${KQL_DASHED.join('|')})\\b`), 'keyword'],
        [/[a-zA-Z_][\w]*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@default': 'predefined' } }],
        [
          /[a-zA-Z_][\w]*/,
          {
            cases: {
              '@tables': 'type',
              '@keywords': 'keyword',
              '@functions': 'predefined',
              '@default': 'identifier',
            },
          },
        ],
        [/\|/, 'delimiter.pipe'],
        [/=~|!~|==|!=|<=|>=|<>|[=<>+\-*/%!]/, 'operator'],
        [/[()[\]{}]/, '@brackets'],
        [/[,;.]/, 'delimiter'],
        [/\s+/, 'white'],
      ],
    },
  } as languages.IMonarchLanguage;
}

export const kqlConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: '//' },
  brackets: [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '[', close: ']' },
    { open: '{', close: '}' },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '(', close: ')' },
    { open: "'", close: "'" },
    { open: '"', close: '"' },
  ],
  wordPattern: /[a-zA-Z_][\w-]*/,
};

export type CompletionKind = 'keyword' | 'function' | 'table' | 'column';

export interface CompletionWord {
  label: string;
  kind: CompletionKind;
}

/** Words offered while typing: tables of the current source, result columns, functions, operators. */
export function completionWords(
  tables: readonly string[],
  columns: readonly string[] = [],
): CompletionWord[] {
  const out = new Map<string, CompletionWord>();
  const add = (label: string, kind: CompletionKind) => {
    if (!out.has(label)) out.set(label, { label, kind });
  };
  tables.forEach((t) => add(t, 'table'));
  columns.forEach((c) => add(c, 'column'));
  KQL_DASHED.forEach((k) => add(k, 'keyword'));
  KQL_KEYWORDS.forEach((k) => add(k, 'keyword'));
  KQL_FUNCTIONS.forEach((f) => add(f, 'function'));
  return [...out.values()];
}
