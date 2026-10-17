import type { KqlSource } from '@adminforge/schemas';
import { AppError } from '../errors';

/**
 * Which Query Studio sources this installation offers (AF_QUERY_SOURCES, all three by default). POST /api/query and
 * POST /api/query/scaffold refuse a source that is switched off before anything is sent to Microsoft or built; the
 * web app reads the same list from GET /api/me (`querySources`) and only offers those.
 */

export const QUERY_SOURCE_LABELS: Record<KqlSource, string> = {
  resourceGraph: 'Azure Resource Graph',
  logAnalytics: 'Log Analytics',
  advancedHunting: 'Advanced hunting',
};

/** Throws 403 `source_off` when `source` isn't one of the `enabled` sources. */
export function requireQuerySource(enabled: readonly KqlSource[], source: KqlSource): void {
  if (enabled.includes(source)) return;
  const others = enabled.map((s) => QUERY_SOURCE_LABELS[s]);
  const instead = others.length ? `Use ${others.join(' or ')} instead, or ask` : 'Ask';
  throw new AppError(
    403,
    'source_off',
    `${QUERY_SOURCE_LABELS[source]} is switched off for this AdminForge.`,
    {
      hint: `${instead} whoever runs this AdminForge to switch it back on.`,
    },
  );
}
