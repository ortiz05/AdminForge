/** Types for after-edit.mjs (imported by tests/unit/tooling). */
export declare const REPO_ROOT: string;
export interface HookChecks {
  readonly prettier: boolean;
  readonly validate: boolean;
  readonly designTokens: boolean;
}
export interface HookDeps {
  /** Runs a command in the repository root; throws (with `stdout`/`stderr`) when it fails. */
  run(cmd: string, args: string[], timeoutMs: number): void;
  readFile(rel: string): Buffer;
}
export declare function editedFile(input: unknown, root?: string): string | null;
export declare function checksFor(rel: string): HookChecks;
export declare function validateFeedback(output: string): string;
export declare function runChecks(rel: string, deps: HookDeps): string[];
