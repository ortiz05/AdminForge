/**
 * How any page opens the playbook drawer: search params on the current URL, so the launch is deep-linkable and
 * survives the arm round trip (POST /auth/arm?returnTo=…).
 *
 *   ?playbook=<key>                      the definition key, e.g. identity.disable-user
 *   &inputs=<base64url(JSON object)>     prefilled inputs (bulk: shared inputs, asked once)
 *   &items=<base64url(JSON array)>       bulk mode: one inputs object per item (e.g. per selected row)
 *   &preview=<runId>                     the dry run shown in the drawer (restored after arming)
 *
 * Items may carry a display-only `$label` (e.g. the row's display name); it is shown in the item list and stripped
 * before the run is submitted.
 */

export const PLAYBOOK_PARAMS = ['playbook', 'inputs', 'items', 'preview'] as const;
export type PlaybookParam = (typeof PLAYBOOK_PARAMS)[number];

/** Display-only key on bulk items. */
export const ITEM_LABEL_KEY = '$label';

export interface PlaybookLaunch {
  playbook: string;
  inputs?: Record<string, unknown>;
  items?: Array<Record<string, unknown>>;
}

export interface PlaybookSearch {
  playbook?: string;
  inputs?: string;
  items?: string;
  preview?: string;
}

const KEY_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const MAX_PARAM = 64 * 1024;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** JSON → base64url (URL-safe, no padding). */
export function encodeParam(value: unknown): string {
  return toBase64Url(JSON.stringify(value));
}

/** base64url → JSON; undefined for anything malformed (a hand-edited URL must not crash the page). */
export function decodeParam(text: unknown): unknown {
  if (typeof text !== 'string' || text === '' || text.length > MAX_PARAM) return undefined;
  try {
    return JSON.parse(fromBase64Url(text));
  } catch {
    return undefined;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Search params for `<Link search>` / `navigate({ search })` that open the drawer. */
export function playbookSearch(launch: PlaybookLaunch): PlaybookSearch {
  return {
    playbook: launch.playbook,
    inputs: launch.inputs && Object.keys(launch.inputs).length ? encodeParam(launch.inputs) : undefined,
    items: launch.items?.length ? encodeParam(launch.items) : undefined,
    preview: undefined,
  };
}

/** A relative href that opens the drawer on top of `pathname` (default: the current page). */
export function playbookHref(launch: PlaybookLaunch, pathname?: string): string {
  const base = pathname ?? (typeof window === 'undefined' ? '/' : window.location.pathname);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(playbookSearch(launch))) if (v) params.set(k, v);
  return `${base}?${params.toString()}`;
}

export interface ParsedLaunch {
  key: string;
  /** False when `playbook` is not a definition key at all (nothing to load). */
  keyValid: boolean;
  inputs: Record<string, unknown>;
  items: Array<Record<string, unknown>> | null;
  preview: string | null;
  /** What was wrong with the URL, in plain words (shown in the drawer instead of failing silently). */
  problems: string[];
}

/** Reads the drawer params from a parsed search object; null when no playbook is requested. */
export function parseLaunch(search: Record<string, unknown>): ParsedLaunch | null {
  const key = search.playbook;
  if (typeof key !== 'string' || key === '') return null;
  const problems: string[] = [];
  const keyValid = KEY_RE.test(key);
  if (!keyValid) problems.push(`“${key}” is not a playbook key.`);

  let inputs: Record<string, unknown> = {};
  if (search.inputs !== undefined) {
    const decoded = decodeParam(search.inputs);
    if (isPlainObject(decoded)) inputs = decoded;
    else problems.push('The prefilled inputs in the link could not be read, so the form starts empty.');
  }

  let items: Array<Record<string, unknown>> | null = null;
  if (search.items !== undefined) {
    const decoded = decodeParam(search.items);
    if (Array.isArray(decoded) && decoded.every(isPlainObject)) items = decoded;
    else problems.push('The selected items in the link could not be read.');
  }

  const preview =
    typeof search.preview === 'string' && /^[\w-]{1,64}$/.test(search.preview) ? search.preview : null;
  return { key, keyValid, inputs, items, preview, problems };
}

/** Search updater that closes the drawer and keeps every other param. */
export function withoutPlaybook(prev: Record<string, unknown>): Record<string, unknown> {
  const next = { ...prev };
  for (const k of PLAYBOOK_PARAMS) next[k] = undefined;
  return next;
}

/** Item inputs without display-only keys. */
export function itemInputs(item: Record<string, unknown>): Record<string, unknown> {
  const { [ITEM_LABEL_KEY]: _label, ...rest } = item;
  return rest;
}

export function itemLabel(item: Record<string, unknown>, index: number): string {
  const label = item[ITEM_LABEL_KEY];
  return typeof label === 'string' && label.trim() ? label : `Item ${index + 1}`;
}
