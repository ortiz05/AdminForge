import { createFileRoute, redirect } from '@tanstack/react-router';

/** Admin links may use the /admin prefix; the page lives at /settings. */
export const Route = createFileRoute('/admin/settings')({
  beforeLoad: () => {
    throw redirect({ to: '/settings', replace: true });
  },
});
