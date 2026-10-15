import { z } from 'zod';
import { blockShape } from '../../lib/schema-common';

/** Guidance text. A safe Markdown subset; raw HTML is shown as text, never rendered (docs/widgets.md › markdown). */
export const MarkdownConfig = z.looseObject({
  widget: z.literal('markdown'),
  ...blockShape,
  text: z.string().min(1).max(20_000),
});
export type MarkdownConfig = z.infer<typeof MarkdownConfig>;
