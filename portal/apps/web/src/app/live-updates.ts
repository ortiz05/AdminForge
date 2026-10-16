import { useQueryClient } from '@tanstack/react-query';
import { forgetAllHistory } from '../query/history';
import { usePortalEvent } from '../runs/event-stream';

/** Query keys that depend on published content: refetched when an administrator publishes. */
const CONTENT_KEYS = [
  ['definition'],
  ['nav'],
  ['schedules'],
  ['reports'],
  ['probes'],
  ['overview'],
  ['capabilities'],
] as const;

/**
 * Keeps an open tab current without a reload: published content (`definitions.changed`) re-renders open pages and the
 * navigation, write access changes or sign-outs in another tab (`session.mode`, `session.ended`) update this one, and
 * a News refresh (`news.updated`) updates the unread badge and the news page.
 */
export function useLiveUpdates(): void {
  const queryClient = useQueryClient();
  usePortalEvent('definitions.changed', () => {
    for (const queryKey of CONTENT_KEYS) void queryClient.invalidateQueries({ queryKey: [...queryKey] });
  });
  usePortalEvent('session.mode', () => void queryClient.invalidateQueries({ queryKey: ['me'] }));
  // The hourly News refresh found new or changed items: the badge, the top-bar pill and an open /news follow.
  usePortalEvent('news.updated', () => void queryClient.invalidateQueries({ queryKey: ['news'] }));
  usePortalEvent('session.ended', () => {
    // Signed out here or in another tab (or the session expired): query history leaves the browser.
    forgetAllHistory();
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  });
}
