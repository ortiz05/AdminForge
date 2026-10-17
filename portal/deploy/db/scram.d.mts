/** Types for scram.mjs (SCRAM-SHA-256 verifiers computed client-side). */
export declare const SCRAM_ITERATIONS: number;
export declare function scramVerifier(password: string, opts?: { salt?: Buffer; iterations?: number }): string;
