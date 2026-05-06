import { useCallback, useState } from 'react';
import useLLMConfig from './useLLMConfig';
import { LOCAL_GEMMA_ENDPOINT } from '../types/llm';
import {
  getLocalGemmaModel,
  type LocalGemmaId,
  type LocalGemmaModel,
} from '../lib/localLlm/models';
import { isModelCached } from '../lib/localLlm/opfsCache';

export type SwitcherState =
  | { phase: 'idle' }
  | { phase: 'checking'; modelId: LocalGemmaId }
  | { phase: 'confirm'; model: LocalGemmaModel };

export interface UseLocalGemmaSwitcherOptions {
  // When true, apply() also triggers ensureLoaded(modelId) so the download
  // starts immediately (chat-header dropdown). When false, apply() only
  // commits config; the caller is responsible for triggering the load
  // (Settings pane defers it to overlay close).
  loadOnApply: boolean;
}

export interface UseLocalGemmaSwitcherResult {
  state: SwitcherState;
  request: (modelId: LocalGemmaId) => void;
  apply: () => void;
  cancel: () => void;
}

export default function useLocalGemmaSwitcher(
  opts: UseLocalGemmaSwitcherOptions,
): UseLocalGemmaSwitcherResult {
  const { config, setActiveEndpoint, setModel } = useLLMConfig();
  const [state, setState] = useState<SwitcherState>({ phase: 'idle' });

  const commit = useCallback(
    (modelId: LocalGemmaId): void => {
      setActiveEndpoint(LOCAL_GEMMA_ENDPOINT);
      setModel(LOCAL_GEMMA_ENDPOINT, modelId);
      if (opts.loadOnApply) {
        void (async () => {
          try {
            const { ensureLoaded } = await import('../lib/localLlm/llmService');
            await ensureLoaded(modelId);
          } catch (err) {
            console.error('Failed to load local Gemma model:', err);
          }
        })();
      }
    },
    [opts.loadOnApply, setActiveEndpoint, setModel],
  );

  const request = useCallback(
    (modelId: LocalGemmaId): void => {
      const model = getLocalGemmaModel(modelId);
      if (!model) return;
      const isAlreadyActive =
        config.activeEndpoint === LOCAL_GEMMA_ENDPOINT &&
        config.models[LOCAL_GEMMA_ENDPOINT] === modelId;
      if (isAlreadyActive) {
        setState({ phase: 'idle' });
        return;
      }
      setState({ phase: 'checking', modelId });
      void (async () => {
        try {
          const cached = await isModelCached(model.url);
          if (cached) {
            commit(modelId);
            setState({ phase: 'idle' });
          } else {
            setState({ phase: 'confirm', model });
          }
        } catch {
          // Fall back to confirm on cache-check failure so the user is still
          // warned about the download size before we hit the network.
          setState({ phase: 'confirm', model });
        }
      })();
    },
    [commit, config.activeEndpoint, config.models],
  );

  const apply = useCallback((): void => {
    if (state.phase !== 'confirm') return;
    const modelId = state.model.id;
    setState({ phase: 'idle' });
    commit(modelId);
  }, [commit, state]);

  const cancel = useCallback((): void => {
    setState({ phase: 'idle' });
  }, []);

  return { state, request, apply, cancel };
}
