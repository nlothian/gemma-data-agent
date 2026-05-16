import { useCallback, useSyncExternalStore } from 'react';
import useCustomModelRestore from '../hooks/useCustomModelRestore';
import useLLMConfig from '../hooks/useLLMConfig';
import { isLocalGemmaEndpoint, LOCAL_GEMMA_ENDPOINT } from '../types/llm';
import {
  getCustomModelsSnapshot,
  subscribeCustomModels,
  type CustomLocalModel,
} from '../lib/localLlm/customModels';

const EMPTY: readonly CustomLocalModel[] = [];

/**
 * Inline banner next to the chat-header model selector. File System Access
 * permission does not survive a reload, so a persisted custom `.task` model
 * needs one user gesture to come back. This surfaces that gesture.
 *
 * v1 limitation: it only appears when the saved custom model is still the
 * active selection in config. If the user switched away from it before
 * reloading, no banner is shown (the handle stays in IndexedDB and can be
 * re-picked via the model menu).
 */
export default function CustomModelRestoreBanner() {
  const { state, restore, clear } = useCustomModelRestore();
  const { config } = useLLMConfig();
  const customModels = useSyncExternalStore(
    subscribeCustomModels,
    getCustomModelsSnapshot,
    () => EMPTY,
  );

  const onRestore = useCallback((): void => {
    void restore();
  }, [restore]);
  const onForget = useCallback((): void => {
    void clear();
  }, [clear]);

  const isActiveSelection =
    isLocalGemmaEndpoint(config.activeEndpoint) &&
    !!state.modelId &&
    config.models[LOCAL_GEMMA_ENDPOINT] === state.modelId;
  const alreadyResolvable =
    !!state.modelId && customModels.some((m) => m.id === state.modelId);
  const showable =
    state.status === 'restorable' ||
    state.status === 'restoring' ||
    state.status === 'permission-denied' ||
    state.status === 'error';

  if (!isActiveSelection || alreadyResolvable || !showable) return null;

  const label = state.label ?? 'custom model';

  return (
    <div className="chat-model-restore" role="status">
      {state.status === 'error' ? (
        <>
          <span>{label} file is no longer available.</span>
          <button
            type="button"
            className="chat-model-restore-btn chat-model-restore-btn--ghost"
            onClick={onForget}
          >
            Forget
          </button>
        </>
      ) : state.status === 'permission-denied' ? (
        <>
          <span>Permission needed.</span>
          <button
            type="button"
            className="chat-model-restore-btn"
            onClick={onRestore}
          >
            Restore {label}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="chat-model-restore-btn"
          onClick={onRestore}
          disabled={state.status === 'restoring'}
        >
          {state.status === 'restoring' ? 'Restoring…' : `Restore ${label}`}
        </button>
      )}
    </div>
  );
}
