import { createFileRoute, redirect } from '@tanstack/react-router';

/** content/navigation.yaml links the Admin section here; the page lives at /audit. */
export const Route = createFileRoute('/admin/audit')({
  beforeLoad: () => {
    throw redirect({ to: '/audit', replace: true });
  },
});
