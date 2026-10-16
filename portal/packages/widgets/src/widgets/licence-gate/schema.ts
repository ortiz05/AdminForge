import { z } from 'zod';
import { blockShape } from '../../lib/schema-common';

export const LICENSED_FEATURES = [
  'conditionalAccess',
  'pim',
  'identityProtection',
  'intune',
  'exchange',
  'teams',
  'sharepoint',
  'defender',
  'defenderEndpoint',
  'signInLogs',
] as const;

/** Explains a missing licence instead of failing (R10) (docs/widgets.md › licenceGate). Renders nothing when licensed. */
export const LicenceGateConfig = z.looseObject({
  widget: z.literal('licenceGate'),
  ...blockShape,
  feature: z.enum(LICENSED_FEATURES),
  /** What the page would show, for the explanation ("managed devices and their compliance"). */
  body: z.string().optional(),
});
export type LicenceGateConfig = z.infer<typeof LicenceGateConfig>;
