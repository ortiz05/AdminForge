/** Each run of valid `%XX` escapes decoded on its own: one stray `%` doesn't leave the rest encoded. */
export const decodeEscapes = (s: string): string =>
  s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

/**
 * Whether a Graph path is `$batch`, however it is written: any case, percent-encoded, runs of `/`, a trailing `/`
 * (the outbound executor sends it as `/$batch` and checks each request inside). A path that starts like a batch but
 * isn't one of these (`/$batch;x`, `/$batch.`) is `startsLikeBatch` — refused rather than sent as one opaque write.
 */
export function isBatchPath(path: string): boolean {
  const p = decodeEscapes(path.split('?')[0]!.split('#')[0]!.trim());
  return (
    p
      .replace(/\/{2,}/g, '/')
      .replace(/\/$/, '')
      .toLowerCase() === '/$batch'
  );
}

export function startsLikeBatch(path: string): boolean {
  const first = decodeEscapes(path.trim()).replace(/^\/+/, '').split('/')[0]?.trim() ?? '';
  return first.toUpperCase().startsWith('$BATCH');
}
