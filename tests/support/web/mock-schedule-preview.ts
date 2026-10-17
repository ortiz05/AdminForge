import { describeCron, parseSchedule, validateCron } from '@adminforge/schemas';
// Relative, not the package subpath: Playwright resolves extensionless .ts imports only outside node_modules.
import { nextRuns } from '../../../portal/apps/web/src/ops/cron';
import { FIXED_NOW } from './fixtures/session';
import type { MockHandler } from './mock-handler';

/**
 * POST /api/schedules/preview for the mock portal API (Playwright specs and component tests): the same answer shape
 * as the BFF (apps/api schedules/scaffold.ts `previewSchedule`) — cron or English in, the cron, a sentence naming the
 * zone, the next five runs after FIXED_NOW, and whether it runs more often than once an hour. Built from the shared
 * describer and grammar, so it answers what the real API would.
 */
export function schedulePreview(body: unknown) {
  const b = (body ?? {}) as { cron?: string; every?: string; timezone?: string };
  const timezone = b.timezone ?? 'UTC';
  const invalid = (problem: string) => ({
    valid: false,
    cron: null,
    text: null,
    timezone,
    next: [],
    tooFrequent: false,
    problem,
  });
  let cron = b.cron?.trim() ?? '';
  let zone = timezone;
  if (b.every !== undefined) {
    const parsed = parseSchedule(b.every);
    if (!parsed.ok) return invalid(parsed.error);
    cron = parsed.cron;
    zone = parsed.timezone ?? timezone;
  }
  const problem = validateCron(cron);
  if (problem) return invalid(problem);
  const runs = nextRuns(cron, zone, 50, new Date(FIXED_NOW));
  const text = describeCron(cron, { timezone: zone });
  return {
    valid: true,
    cron,
    text: text.startsWith('Custom:') ? null : text,
    timezone: zone,
    next: runs.slice(0, 5).map((d) => d.toISOString()),
    tooFrequent: runs.some((d, i) => i > 0 && d.getTime() - runs[i - 1]!.getTime() < 3_600_000),
  };
}

export const schedulePreviewHandler: MockHandler = ({ method, path, body }) =>
  method === 'POST' && path === '/api/schedules/preview' ? { body: schedulePreview(body) } : undefined;
