import { cnMerge, createTV, type ClassValue } from 'tailwind-variants';
import { fonts, scale, SEMANTIC_KEYS } from '@adminforge/design-tokens';

/**
 * tailwind-merge must know our token names, or it treats `text-fg` (colour) and `text-2xs` (size)
 * as the same group and silently drops one of them.
 */
export const twMergeConfig = {
  extend: {
    theme: {
      color: [...SEMANTIC_KEYS, 'transparent', 'current'],
      text: Object.keys(scale.fontSize),
      radius: Object.keys(scale.radius),
      shadow: Object.keys(scale.shadow),
      font: Object.keys(fonts),
    },
  },
};

/** The only way variants and sizes are defined (§6.8 recipes). */
export const tv = createTV({ twMergeConfig });

/** Joins class names and resolves conflicts with the token-aware merger (last one wins). */
export function cn(...classes: ClassValue[]): string {
  return (cnMerge(...classes)({ twMergeConfig }) as string | undefined) ?? '';
}
