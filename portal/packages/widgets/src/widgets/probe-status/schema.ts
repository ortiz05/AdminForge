import { z } from 'zod';
import { DefinitionId } from '@adminforge/schemas';
import { blockShape } from '../../lib/schema-common';

/**
 * Latest result + sparkline per synthetic probe (docs/widgets.md › probeStatus). `probes` lists them by key, `group`
 * picks every probe of one service (the probe's `group`); omit both for all.
 */
export const ProbeStatusConfig = z.looseObject({
  widget: z.literal('probeStatus'),
  ...blockShape,
  probes: z.array(DefinitionId).min(1).optional(),
  group: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
});
export type ProbeStatusConfig = z.infer<typeof ProbeStatusConfig>;
