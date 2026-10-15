import { createFileRoute } from '@tanstack/react-router';
import { AppearancePage } from '../ops/AppearancePage';

export const Route = createFileRoute('/appearance')({
  component: AppearancePage,
});
