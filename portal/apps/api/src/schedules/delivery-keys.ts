import type { DeliveryOptionsResponse, Schedule } from '@adminforge/schemas';
import { RECIPIENT_KEY, SENDER_KEY, WEBHOOK_KEY } from '../delivery/notifier';

/**
 * Delivery targets by configuration key name. Recipients and webhook URLs are installation configuration
 * (`${ env.AF_… }` in a schedule, resolved by delivery/notifier.ts at send time); the API only ever shows or accepts the
 * key names, never their values.
 */

const ENV_REF = /^\s*\$\{\s*env\.([A-Z][A-Z0-9_]*)\s*\}\s*$/;

/** The key of a `${ env.KEY }` reference, or null. */
export function envRefKey(ref: unknown): string | null {
  return typeof ref === 'string' ? (ENV_REF.exec(ref)?.[1] ?? null) : null;
}

/** "AF_REPORT_RECIPIENTS" → "Report recipients"; "AF_TEAMS_ALERTS_WEBHOOK" → "Teams alerts". */
export function deliveryKeyLabel(key: string): string {
  const words = key
    .replace(/^AF_/, '')
    .replace(/_WEBHOOK$/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const text = words.join(' ') || key;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type Env = Record<string, string | undefined>;

const configured = (env: Env, key: string) => !!env[key]?.trim();

/** Keys kept for approval requests (AF_APPROVALS_EMAIL, AF_APPROVALS_TEAMS_WEBHOOK): never a report destination. */
const RESERVED_KEY = /^AF_APPROVALS_/;

/** Whether `key` names a configured recipient list (email) that report schedules may use. */
export const isRecipientList = (env: Env, key: string) =>
  !RESERVED_KEY.test(key) && RECIPIENT_KEY.test(key) && configured(env, key);
/** Whether `key` names a configured Teams webhook that report schedules may use. */
export const isWebhook = (env: Env, key: string) =>
  !RESERVED_KEY.test(key) && WEBHOOK_KEY.test(key) && configured(env, key);
/** Whether email can be sent at all (the sender mailbox is configured). */
export const mailAvailable = (env: Env) => configured(env, SENDER_KEY);

/** GET /api/schedules/delivery-options: configured recipient lists and webhooks, by name (approval keys left out). */
export function deliveryOptions(env: Env): DeliveryOptionsResponse {
  const lists = (test: (key: string) => boolean) =>
    Object.keys(env)
      .filter(test)
      .sort()
      .map((key) => ({ key, label: deliveryKeyLabel(key) }));
  return {
    email: { available: mailAvailable(env), lists: lists((k) => isRecipientList(env, k)) },
    teams: { lists: lists((k) => isWebhook(env, k)) },
  };
}

export type DeliveryView =
  | { type: 'file'; format: string; retain: number | null }
  | { type: 'email'; key: string; label: string; format: string }
  | { type: 'teams'; key: string; label: string };
export interface NotifyView {
  type: 'email' | 'teams';
  key: string;
  label: string;
}

const target = (key: string) => ({ key, label: deliveryKeyLabel(key) });

/** Where a schedule's report goes and who hears about failures, as key names (never values). */
export function deliveryView(def: Schedule): { delivery?: DeliveryView[]; notify?: NotifyView[] } {
  const out: { delivery?: DeliveryView[]; notify?: NotifyView[] } = {};
  if (def.job.kind === 'report') {
    const delivery: DeliveryView[] = [];
    for (const d of def.job.delivery) {
      if (d.type === 'file') delivery.push({ type: 'file', format: d.format, retain: d.retain ?? null });
      else if (d.type === 'email') {
        for (const key of d.to.map(envRefKey))
          if (key) delivery.push({ type: 'email', ...target(key), format: d.format });
      } else {
        const key = envRefKey(d.webhook);
        if (key) delivery.push({ type: 'teams', ...target(key) });
      }
    }
    out.delivery = delivery;
  }
  const notify: NotifyView[] = [];
  for (const n of def.notify?.onFailure ?? []) {
    if (n.type === 'email') {
      for (const key of n.to.map(envRefKey)) if (key) notify.push({ type: 'email', ...target(key) });
    } else {
      const key = envRefKey(n.webhook);
      if (key) notify.push({ type: 'teams', ...target(key) });
    }
  }
  if (notify.length) out.notify = notify;
  return out;
}
