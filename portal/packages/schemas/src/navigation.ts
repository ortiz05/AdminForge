import { z } from 'zod';
import { PortalRole } from './api';
import { IconName, envelopeShape } from './common';

/**
 * navigation.yaml: section order, labels and icons (§6.5). Pages, dashboards, reports, playbooks and runbooks join a
 * section through their `nav.section` (unless the section says `listDefinitions: false`); `items` add coded routes
 * (Runs, Schedules, Audit, the Reports catalogue, …).
 * (Named Navigation* to stay clear of the NavSection/NavItem API response types.)
 */

const Key = z.string().regex(/^[a-z][a-z0-9-]*$/, 'Use a lower-case kebab key');

export const NavigationItem = z.strictObject({
  key: Key,
  label: z.string().min(1),
  /** In-app route, e.g. /runs. */
  href: z.string().regex(/^\/[^\s]*$/, 'Expected an in-app path starting with /'),
  icon: IconName.optional(),
  order: z.number().int().optional(),
  roles: z.array(PortalRole).optional(),
  /** Shown even while its section is collapsed (Monitoring, News and changes: always one click away). */
  pinned: z.boolean().optional(),
});
export type NavigationItem = z.infer<typeof NavigationItem>;

export const NavigationSection = z.strictObject({
  key: Key,
  label: z.string().min(1),
  icon: IconName,
  order: z.number().int().optional(),
  /** Hide the section unless the user holds one of these roles. */
  roles: z.array(PortalRole).optional(),
  /**
   * Whether definitions whose `nav.section` is this section are listed in the rail (default true). `false` lists only
   * `items` (e.g. Reports: one "All reports" entry for the catalogue); the definitions stay reachable by URL, search
   * and their catalogue.
   */
  listDefinitions: z.boolean().optional(),
  items: z.array(NavigationItem).optional(),
});
export type NavigationSection = z.infer<typeof NavigationSection>;

export const Navigation = z
  .strictObject({
    kind: z.literal('navigation'),
    ...envelopeShape,
    sections: z.array(NavigationSection).min(1),
  })
  .superRefine((def, ctx) => {
    const seen = new Set<string>();
    def.sections.forEach((s, i) => {
      if (seen.has(s.key))
        ctx.addIssue({
          code: 'custom',
          path: ['sections', i, 'key'],
          message: `Duplicate section key "${s.key}".`,
        });
      seen.add(s.key);
      const items = new Set<string>();
      s.items?.forEach((it, j) => {
        if (items.has(it.key))
          ctx.addIssue({
            code: 'custom',
            path: ['sections', i, 'items', j, 'key'],
            message: `Duplicate item key "${it.key}".`,
          });
        items.add(it.key);
      });
    });
  });
export type Navigation = z.infer<typeof Navigation>;
