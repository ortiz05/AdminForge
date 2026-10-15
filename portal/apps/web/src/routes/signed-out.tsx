import { createFileRoute } from '@tanstack/react-router';
import { SignedOutPage } from '../pages/public/PublicPage';

/** Landing page after sign-out (public: it must not send the browser back to sign-in). */
export const Route = createFileRoute('/signed-out')({
  component: SignedOutPage,
});
