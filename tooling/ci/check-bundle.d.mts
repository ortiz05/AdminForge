/** Types for check-bundle.mjs (imported by tests/unit/tooling). */
export declare const DEFAULT_DIST: string;
export declare const DEFAULT_BUDGET_KB: number;
export declare function initialScripts(html: string): string[];
export declare function measureInitialLoad(dist: string): {
  files: Array<{ file: string; gzipBytes: number }>;
  totalBytes: number;
};
export declare function checkBundle(
  dist: string,
  budgetKb: number,
): { ok: boolean; out: string[]; err: string[] };
