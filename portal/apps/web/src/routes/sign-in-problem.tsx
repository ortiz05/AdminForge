import { createFileRoute } from '@tanstack/react-router';
import { SignInProblemPage, validateProblemSearch } from '../pages/public/PublicPage';

/** Where the API sends the browser when a sign-in or write-access round trip fails (public, no session). */
export const Route = createFileRoute('/sign-in-problem')({
  validateSearch: validateProblemSearch,
  component: function SignInProblemRoute() {
    return <SignInProblemPage search={Route.useSearch()} />;
  },
});
