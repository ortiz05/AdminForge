import { Link, useRouterState } from '@tanstack/react-router';
import {
  Button,
  EmptyState,
  Kbd,
  modKey,
  PageHeader,
  Panel,
  SquaresFourIcon,
  button,
  cn,
} from '@adminforge/ui';
import { useShell } from '../app/shell-context';

/**
 * Any address no route serves (a mistyped link, a retired coded page, a navigation entry pointing nowhere): says so,
 * shows the address, and offers the two ways on — the command palette and the overview.
 */
export function NotFoundPage() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { openPalette } = useShell();
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
              <Link to="/" className={cn(button({ intent: 'ghost' }), 'text-accent')}>
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
