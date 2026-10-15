import { z } from 'zod';
import { DefinitionId } from '@adminforge/schemas';
import { blockShape } from '../../lib/schema-common';

/** Latest result + sparkline per synthetic probe (docs/widgets.md › probeStatus). Omit `probes` for all. */
export const ProbeStatusConfig = z.looseObject({
  widget: z.literal('probeStatus'),
  ...blockShape,
  probes: z.array(DefinitionId).min(1).optional(),
});
export type ProbeStatusConfig = z.infer<typeof ProbeStatusConfig>;
