import type { SVGProps } from 'react';
import { brand } from '../recipes/brand';

/** The anvil: horn to the left, flat face, waisted body, flared foot. Drawn in currentColor. */
export function AnvilMark({ size = 20, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      focusable="false"
      {...rest}
    >
      <path d="M1 6h21.5v2.6a2 2 0 0 1-2 2h-3.2l-1.9 3.1v1.6l3.6 2.9V20H5v-1.8l3.6-2.9v-1.6l-1.9-3.1H6.4C3.6 10.6 1.6 8.8 1 6Z" />
    </svg>
  );
}

export interface BrandProps {
  size?: 'sm' | 'md' | 'lg';
  compact?: boolean;
  /** Sits in the session rail (inherits the armed ink). */
  rail?: boolean;
  className?: string;
}

/** Wordmark "Admin" (fg-2, 500) + "Forge" (fg, 700) in Archivo at wdth 118, with the temper-blue anvil. */
export function Brand({ size = 'md', compact, rail, className }: BrandProps) {
  const s = brand({ size, compact, rail });
  const markSize = size === 'lg' ? 30 : size === 'sm' ? 18 : 22;
  return (
    <span className={s.root({ className })}>
      <AnvilMark size={markSize} className={s.mark()} />
      <span className={s.word()}>
        <span className={s.admin()}>Admin</span>
        <span className={s.forge()}>Forge</span>
      </span>
    </span>
  );
}
