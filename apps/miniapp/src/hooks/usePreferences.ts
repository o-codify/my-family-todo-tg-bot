import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type MeResponse, type UserPreferences } from '../api';

/**
 * Read + write helpers for the per-user preferences bag.
 *
 * `set(patch)` PATCHes the server *and* applies an optimistic update to the
 * `['me']` cache so UI driven by a preference (e.g. calendar view mode chip)
 * doesn't lag a network roundtrip. The server response replaces the cache
 * on success; on failure we roll back to the snapshot.
 *
 * Pass `{ key: null }` to clear a single key — the server strips nulls
 * before saving so the row stays compact.
 */
export function usePreferences(me: MeResponse) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (patch: Partial<UserPreferences>) =>
      api.updateMe({ preferences: patch }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ['me'] });
      const prev = queryClient.getQueryData<MeResponse>(['me']);
      if (prev) {
        const next: MeResponse = {
          ...prev,
          preferences: pruneNulls({ ...prev.preferences, ...patch }),
        };
        queryClient.setQueryData(['me'], next);
      }
      return { prev };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['me'], ctx.prev);
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['me'], updated);
    },
  });

  const set = useCallback(
    (patch: Partial<UserPreferences>) => mutation.mutate(patch),
    [mutation],
  );

  return {
    prefs: me.preferences,
    set,
    isPending: mutation.isPending,
  };
}

function pruneNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}
