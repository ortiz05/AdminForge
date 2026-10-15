import { createFileRoute } from '@tanstack/react-router';
import { SettingsPage } from '../ops/SettingsPage';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});
