import { STATUS_TONE_LABEL, columnMapEntry } from '@adminforge/schemas';
import { STATUS_TONES, type StatusTone } from '@adminforge/ui';

/** `[tone, label]` or `{ tone, label }`, as content writes them. */
export type StatusEntry = readonly [StatusTone, string] | { tone: StatusTone; label: string };
export type StatusMap = Record<string, StatusEntry>;

export interface Status {
  tone: StatusTone;
  label: string;
}

export const isTone = (v: unknown): v is StatusTone =>
  typeof v === 'string' && (STATUS_TONES as readonly string[]).includes(v);

/** Default words for a bare tone (KPI status expressions return just the tone). */
export const TONE_LABEL: Record<StatusTone, string> = STATUS_TONE_LABEL;

export function toStatus(entry: StatusEntry): Status {
  return Array.isArray(entry) ? { tone: entry[0], label: entry[1] } : (entry as Status);
}

/**
 * Turns a raw value into status + label (always both — never colour alone). Unmapped values use `fallback`,
 * a bare tone uses its default label, and anything else shows as neutral text.
 */
export function mapStatus(value: unknown, map?: StatusMap, fallback?: StatusEntry): Status | null {
  // The same lookup the export uses (@adminforge/schemas › columnMapEntry), so a file says what the cell shows.
  const hit = map ? columnMapEntry(map, value) : undefined;
  if (hit && typeof hit !== 'string') return toStatus(hit);
  if (fallback) return toStatus(fallback);
  if (isTone(value)) return { tone: value, label: TONE_LABEL[value] };
  if (value === undefined || value === null || value === '') return null;
  return { tone: 'neutral', label: String(value) };
}
