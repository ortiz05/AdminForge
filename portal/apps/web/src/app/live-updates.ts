import { useQueryClient } from '@tanstack/react-query';
import { usePortalEvent } from '../runs/event-stream';

/** Query keys that depend on published content: refetched when an administrator publishes. */
const CONTENT_KEYS = [
  ['definition'],
  ['nav'],
  ['schedules'],
  ['probes'],
  ['overview'],
  ['capabilities'],
] as const;

/**
 * Keeps an open tab current without a reload: published content (`definitions.changed`) re-renders open pages and the
 * navigation, and write access changes or sign-outs in another tab (`session.mode`, `session.ended`) update this one.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  usePortalEvent('definitions.changed', () => {
    for (const queryKey of CONTENT_KEYS) void queryClient.invalidateQueries({ queryKey: [...queryKey] });
  });
  usePortalEvent('session.mode', () => void queryClient.invalidateQueries({ queryKey: ['me'] }));
  usePortalEvent('session.ended', () => void queryClient.invalidateQueries({ queryKey: ['me'] }));
}
