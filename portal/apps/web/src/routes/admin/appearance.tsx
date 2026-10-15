import { createFileRoute, redirect } from '@tanstack/react-router';

/** content/navigation.yaml links the Admin section here; the page lives at /appearance. */
export const Route = createFileRoute('/admin/appearance')({
  beforeLoad: () => {
    throw redirect({ to: '/appearance', replace: true });
  },
});
