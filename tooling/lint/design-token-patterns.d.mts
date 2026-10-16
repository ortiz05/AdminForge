/** Types for design-token-patterns.mjs (imported by tests/guards and tests/unit/tooling). */
export declare const UI_FILE: RegExp;
export declare const UI_LINT_GLOBS: readonly string[];
export declare const RAW_COLOUR_SOURCE: string;
export declare const ARBITRARY_VALUE_SOURCE: string;
export declare const RAW_COLOUR: RegExp;
export declare const ARBITRARY_VALUE: RegExp;
export declare const MESSAGES: { readonly rawColour: string; readonly arbitraryValue: string };
export type TokenViolationKind = 'rawColour' | 'arbitraryValue';
export interface TokenViolation {
  readonly line: number;
  readonly kind: TokenViolationKind;
  readonly text: string;
}
export declare function isUiFile(rel: string): boolean;
export declare function findTokenViolations(text: string): TokenViolation[];
