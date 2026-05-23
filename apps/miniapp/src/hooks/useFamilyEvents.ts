import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getInitData } from '../telegram';

/**
 * Server-sent events listener for one family. Opens an EventSource pointed
 * at `/api/v1/families/:familyId/events?auth=<initData>` and invalidates
 * matching TanStack Query keys when the server publishes hints.
 *
 * The 8-second polling we use elsewhere is still active as a fallback —
 * if SSE drops (e.g. flaky network, mobile background-throttle), polling
 * eventually picks up the change. SSE is the fast path.
 *
 * EventSource auto-reconnects on its own with exponential backoff, so we
 * don't add any reconnect logic here. We just open it once per familyId
 * and close on unmount / id change.
 */
type Event =
  | {
      kind: 'invalidate';
      scope:
        | 'occurrences'
        | 'tasks'
        | 'members'
        | 'families'
        | 'stats'
        | 'shopping'
        | 'events'
        | 'meal-plan';
    }
  | { kind: 'invalidate-all' }
  | { kind: 'hello' };

export function useFamilyEvents(familyId: string | null): void {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!familyId) return;
    const auth = getInitData();
    if (!auth) return; // Dev mode without initData — skip SSE.

    const base = (import.meta.env.VITE_API_URL as string | undefined) ?? '';
    const url = `${base}/api/v1/families/${familyId}/events?auth=${encodeURIComponent(auth)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('message', (msg) => {
      let parsed: Event;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (parsed.kind === 'invalidate-all') {
        queryClient.invalidateQueries();
        return;
      }
      if (parsed.kind === 'invalidate') {
        // Map the coarse scope to the actual query keys used elsewhere.
        switch (parsed.scope) {
          case 'occurrences':
            queryClient.invalidateQueries({ queryKey: ['occurrences', familyId] });
            queryClient.invalidateQueries({ queryKey: ['stats', familyId] });
            break;
          case 'tasks':
            queryClient.invalidateQueries({ queryKey: ['tasks', familyId] });
            queryClient.invalidateQueries({ queryKey: ['occurrences', familyId] });
            break;
          case 'members':
            queryClient.invalidateQueries({ queryKey: ['members', familyId] });
            break;
          case 'families':
            queryClient.invalidateQueries({ queryKey: ['families'] });
            break;
          case 'stats':
            queryClient.invalidateQueries({ queryKey: ['stats', familyId] });
            break;
          case 'shopping':
            queryClient.invalidateQueries({ queryKey: ['shopping', familyId] });
            break;
          case 'events':
            queryClient.invalidateQueries({ queryKey: ['family-events', familyId] });
            break;
          case 'meal-plan':
            queryClient.invalidateQueries({ queryKey: ['meal-plan', familyId] });
            break;
        }
      }
    });

    // EventSource fires `error` on transient blips too; let the browser
    // retry. We only log if the readyState is CLOSED (terminal).
    es.addEventListener('error', () => {
      if (es.readyState === EventSource.CLOSED) {
        // Terminal; browser won't reconnect. Surface via console only —
        // polling still keeps the UI eventually-consistent.
        // eslint-disable-next-line no-console
        console.warn('[realtime] SSE closed permanently');
      }
    });

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [familyId, queryClient]);
}
