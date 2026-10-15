import type { ComponentProps } from 'react';
import { cn } from '../recipes/tv';
import { skeleton } from '../recipes/skeleton';

export type SkeletonProps = ComponentProps<'span'> & { shape?: 'line' | 'block' | 'circle' };

/** Placeholder for content that is loading. Decorative: pair it with an aria-busy container or a label. */
export function Skeleton({ shape, className, ...rest }: SkeletonProps) {
  return <span aria-hidden {...rest} className={skeleton({ shape, className })} />;
}

/** A few lines of text-shaped skeleton. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cn('flex flex-col gap-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={i === lines - 1 ? 'w-3/5' : undefined} />
      ))}
    </span>
  );
}
