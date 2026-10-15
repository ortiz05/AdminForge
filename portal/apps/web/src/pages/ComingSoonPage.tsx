import { Link, useRouterState } from '@tanstack/react-router';
import {
  Badge,
  Button,
  CheckIcon,
  EmptyState,
  Kbd,
  modKey,
  PageHeader,
  Panel,
  Skeleton,
  SquaresFourIcon,
} from '@adminforge/ui';
import { RouterLink } from '../app/RouterLink';
import { useShell } from '../app/shell-context';
import { plannedPage } from '../lib/catalog';
import { useNav } from '../lib/session';

/** A nav entry whose page isn't built yet explains itself; an unknown path says so plainly. */
export function ComingSoonPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const nav = useNav();
  const { openPalette } = useShell();

  if (nav.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-72" />
      </div>
    );
  }

  const section = nav.data?.sections.find((s) => s.items.some((i) => i.href === pathname));
  const item = section?.items.find((i) => i.href === pathname);

  if (!section || !item) {
    return (
      <>
        <PageHeader
          eyebrow="Not found"
          title="There’s no page at this address"
          description={<code className="text-fg-3">{pathname}</code>}
        />
        <Panel>
          <EmptyState
            title="Check the link, or jump to a page"
            icon={<SquaresFourIcon size={20} />}
            action={
              <>
                <Button intent="primary" onClick={openPalette}>
                  Open the command palette
                  <Kbd keys={[modKey(), 'K']} />
                </Button>
                <Link
                  to="/"
                  className="inline-flex h-(--af-control-h) items-center rounded-md px-3 font-semibold text-accent hover:bg-hover"
                >
                  Go to Overview
                </Link>
              </>
            }
          >
            The page may have moved, or it isn’t published for your roles.
          </EmptyState>
        </Panel>
      </>
    );
  }

  const planned = plannedPage(item.key, item.href);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: section.label }, { label: item.label, href: item.href }]}
        linkAs={RouterLink}
        eyebrow={section.label}
        title={item.label}
        meta={<Badge tone="accent">Coming soon</Badge>}
        description={
          planned?.summary ?? 'This page is planned and appears here once its definition is published.'
        }
      />
      <div className="grid gap-(--af-gap-grid) lg:grid-cols-3">
        <Panel eyebrow="Planned" title="What you’ll be able to do here" className="lg:col-span-2">
          {planned ? (
            <ul className="flex flex-col gap-3">
              {planned.capabilities.map((c) => (
                <li key={c} className="flex items-start gap-3 text-fg-2">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm bg-accent-subtle text-accent">
                    <CheckIcon size={12} weight="bold" aria-hidden />
                  </span>
                  {c}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-fg-2">Its capabilities are listed when the page definition is drafted.</p>
          )}
        </Panel>
        <Panel eyebrow="How pages arrive" title="Content, not releases">
          <p className="text-sm text-fg-2">
            Pages are YAML definitions reviewed in Git. When this one is published it replaces this
            placeholder at the same address, with no redeploy.
          </p>
          <p className="mt-3 text-sm text-fg-3">
            Until then, press <Kbd keys={[modKey(), 'K']} className="mx-0.5 align-middle" /> to jump to pages
            that are live.
          </p>
        </Panel>
      </div>
    </>
  );
}
