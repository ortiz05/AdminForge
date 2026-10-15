import type { ComponentProps } from 'react';
import { Tabs as T } from 'radix-ui';
import { tabs } from '../recipes/tabs';

/** Tabs (Radix): arrow keys move between tabs; the panel follows. */
export const Tabs = T.Root;

export function TabsList({ className, ...rest }: ComponentProps<typeof T.List>) {
  return <T.List {...rest} className={tabs().list({ className })} />;
}

export function TabsTrigger({ className, ...rest }: ComponentProps<typeof T.Trigger>) {
  return <T.Trigger {...rest} className={tabs().trigger({ className })} />;
}

export function TabsContent({ className, ...rest }: ComponentProps<typeof T.Content>) {
  return <T.Content {...rest} className={tabs().content({ className })} />;
}
