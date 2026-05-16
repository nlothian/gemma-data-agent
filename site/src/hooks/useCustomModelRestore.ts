import { useCallback, useSyncExternalStore } from 'react';
import * as store from '../lib/localLlm/customModelStore';
import type {
  CustomModelRestoreState,
  RestoreResult,
} from '../lib/localLlm/customModelStore';

export interface UseCustomModelRestoreResult {
  state: CustomModelRestoreState;
  restore: () => Promise<RestoreResult>;
  clear: () => Promise<void>;
}

/**
 * React binding for `customModelStore` — mirrors `useSandboxConfig`. Drives
 * the custom-model restore banner near the chat-header model selector.
 */
export default function useCustomModelRestore(): UseCustomModelRestoreResult {
  store.hydrateOnce();
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  const restore = useCallback(async (): Promise<RestoreResult> => {
    try {
      return await store.restoreFromHandle();
    } catch (err) {
      console.error('restoreFromHandle failed:', err);
      return { ok: false, reason: 'error' };
    }
  }, []);

  const clear = useCallback(async () => {
    try {
      await store.clearPersistedCustomModel();
    } catch (err) {
      console.error('clearPersistedCustomModel failed:', err);
    }
  }, []);

  return { state, restore, clear };
}
