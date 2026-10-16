/** Types for commit-message.mjs (imported by tests/unit/tooling). */
export declare const TYPES: readonly string[];
export declare const SCOPES: readonly string[];
export declare const MAX_HEADER: number;
export declare function cleanMessage(raw: string): string;
export declare function checkCommitMessage(raw: string, opts?: { title?: boolean }): string[];
