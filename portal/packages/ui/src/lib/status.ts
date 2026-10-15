import {
  CheckCircleIcon,
  InfoIcon,
  MinusCircleIcon,
  WarningIcon,
  XCircleIcon,
  type Icon,
} from '@phosphor-icons/react';

/** State colours (patina / straw / cinder / temper / steel). Ember is never a status. */
export const STATUS_TONES = ['ok', 'warn', 'crit', 'info', 'neutral'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

/** Each tone has its own glyph shape, so state never depends on colour alone. */
export const STATUS_ICON: Record<StatusTone, Icon> = {
  ok: CheckCircleIcon,
  warn: WarningIcon,
  crit: XCircleIcon,
  info: InfoIcon,
  neutral: MinusCircleIcon,
};

/** Sort order: the most urgent first. */
export const STATUS_SEVERITY: Record<StatusTone, number> = { crit: 4, warn: 3, info: 2, ok: 1, neutral: 0 };

export const STATUS_TEXT: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  crit: 'text-crit',
  info: 'text-info',
  neutral: 'text-neutral',
};
