import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAvailableModels } from '../lib/llm';

export type ProviderModelsEntry =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; models: string[]; fetchedAt: number }
  | { status: 'error'; message: string };

export interface UseProviderModelsResult {
  getEntry: (endpointUrl: string) => ProviderModelsEntry;
  refresh: (endpointUrl: string, apiKey: string | undefined) => void;
}

const IDLE: ProviderModelsEntry = { status: 'idle' };

function toMessage(err: unknown): string {
  if (err instanceof TypeError) {
    return 'Could not reach endpoint (network or CORS)';
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export function useProviderModels(): UseProviderModelsResult {
  const [entries, setEntries] = useState<Record<string, ProviderModelsEntry>>({});
  const controllersRef = useRef<Record<string, AbortController>>({});

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const c of Object.values(controllers)) c.abort();
    };
  }, []);

  const getEntry = useCallback(
    (endpointUrl: string): ProviderModelsEntry => entries[endpointUrl] ?? IDLE,
    [entries],
  );

  const refresh = useCallback(
    (endpointUrl: string, apiKey: string | undefined): void => {
      if (!endpointUrl) return;

      const prev = controllersRef.current[endpointUrl];
      if (prev) prev.abort();

      const controller = new AbortController();
      controllersRef.current[endpointUrl] = controller;

      setEntries((e) => ({ ...e, [endpointUrl]: { status: 'loading' } }));

      fetchAvailableModels(endpointUrl, apiKey, controller.signal)
        .then((models) => {
          if (controllersRef.current[endpointUrl] !== controller) return;
          delete controllersRef.current[endpointUrl];
          setEntries((e) => ({
            ...e,
            [endpointUrl]: { status: 'success', models, fetchedAt: Date.now() },
          }));
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          if (controllersRef.current[endpointUrl] !== controller) return;
          delete controllersRef.current[endpointUrl];
          setEntries((e) => ({
            ...e,
            [endpointUrl]: { status: 'error', message: toMessage(err) },
          }));
        });
    },
    [],
  );

  return { getEntry, refresh };
}

export default useProviderModels;
