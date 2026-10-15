import { createFileRoute } from '@tanstack/react-router';
import { DesignPage } from '../pages/design/DesignPage';

export const Route = createFileRoute('/design')({
  component: DesignPage,
});
