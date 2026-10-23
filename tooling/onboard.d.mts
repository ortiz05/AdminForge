// Types for tooling/onboard.mjs (imported by tests/unit/tooling/onboard.test.ts).
export interface Result {
  status: 'ok' | 'fixed' | 'warn' | 'fail';
  name: string;
  detail?: string;
  fix?: string;
}
export declare const REPO_ROOT: string;
export declare const CHROME_PATHS: Record<string, string[]>;
export declare function pinnedNodeMajor(nvmrc: string | undefined): number | null;
export declare function pinnedPnpm(packageJson: { packageManager?: string } | undefined): string | null;
export declare function frontMatter(text: string): Record<string, string> | null;
export declare function checkSkillsAndAgents(
  io: { list: (dir: string) => string[]; read: (file: string) => string; exists: (file: string) => boolean },
  root?: string,
): Result[];
export declare function checkClaudeSettings(
  io: { read: (file: string) => string; exists: (file: string) => boolean },
  root?: string,
): Result;
export declare function checkGitHooks(
  io: {
    git: (...args: string[]) => string;
    exists: (file: string) => boolean;
    executable: (file: string) => boolean;
  },
  root?: string,
): Result;
export declare function checkCommitMessageRule(accepts: (message: string) => boolean): Result;
export declare function checkEnvFile(
  io: { exists: (file: string) => boolean; mode: (file: string) => number },
  home?: string,
): Result;
export declare function formatResult(r: Result): string;
