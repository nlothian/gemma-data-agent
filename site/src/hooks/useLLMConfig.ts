import { useCallback, useSyncExternalStore } from 'react';
import { generateId, isBrowser } from '../lib/browser';
import {
  EMPTY_LLM_CONFIG,
  LLM_CONFIG_STORAGE_KEY,
  type CustomEndpoint,
  type LLMConfig,
} from '../types/llm';

type StoredLLMConfig = Omit<LLMConfig, 'models' | 'thinkingEnabled'> & {
  models?: Record<string, string>;
  thinkingEnabled?: Record<string, boolean>;
};

function isLLMConfigShape(value: unknown): value is StoredLLMConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const activeOk = v.activeEndpoint === null || typeof v.activeEndpoint === 'string';
  const customOk = Array.isArray(v.customEndpoints);
  const keysOk =
    v.apiKeys !== null && typeof v.apiKeys === 'object' && !Array.isArray(v.apiKeys);
  const modelsOk =
    v.models === undefined ||
    (v.models !== null && typeof v.models === 'object' && !Array.isArray(v.models));
  const thinkingOk =
    v.thinkingEnabled === undefined ||
    (v.thinkingEnabled !== null &&
      typeof v.thinkingEnabled === 'object' &&
      !Array.isArray(v.thinkingEnabled));
  return activeOk && customOk && keysOk && modelsOk && thinkingOk;
}

function readStorage(): LLMConfig | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(LLM_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isLLMConfigShape(parsed)) return null;
    return {
      activeEndpoint: parsed.activeEndpoint,
      customEndpoints: parsed.customEndpoints,
      apiKeys: parsed.apiKeys,
      models: parsed.models ?? {},
      thinkingEnabled: parsed.thinkingEnabled ?? {},
    };
  } catch {
    return null;
  }
}

function writeStorage(config: LLMConfig): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(LLM_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Silently ignore quota / private-mode / access errors.
  }
}

let currentConfig: LLMConfig = EMPTY_LLM_CONFIG;
let hydrated = false;
const listeners = new Set<() => void>();

function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;
  const existing = readStorage();
  if (existing) currentConfig = existing;
  if (isBrowser()) {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== LLM_CONFIG_STORAGE_KEY) return;
      const next = readStorage();
      if (!next) return;
      currentConfig = next;
      notify();
    });
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LLMConfig {
  return currentConfig;
}

function getServerSnapshot(): LLMConfig {
  return EMPTY_LLM_CONFIG;
}

function update(mutator: (prev: LLMConfig) => LLMConfig): void {
  const next = mutator(currentConfig);
  if (next === currentConfig) return;
  currentConfig = next;
  writeStorage(next);
  notify();
}

export interface UseLLMConfigResult {
  config: LLMConfig;
  ready: boolean;
  setActiveEndpoint: (url: string | null) => void;
  setApiKey: (endpointUrl: string, apiKey: string) => void;
  setModel: (endpointUrl: string, model: string) => void;
  setThinkingEnabled: (endpointUrl: string, enabled: boolean) => void;
  addCustomEndpoint: () => string;
  updateCustomEndpoint: (
    id: string,
    patch: Partial<Pick<CustomEndpoint, 'label' | 'url'>>,
  ) => void;
  removeCustomEndpoint: (id: string) => void;
}

export function useLLMConfig(): UseLLMConfigResult {
  hydrateOnce();
  const config = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setActiveEndpoint = useCallback((url: string | null): void => {
    update((prev) => ({ ...prev, activeEndpoint: url }));
  }, []);

  const setApiKey = useCallback((endpointUrl: string, apiKey: string): void => {
    update((prev) => {
      const trimmed = apiKey.trim();
      const nextKeys: Record<string, string> = { ...prev.apiKeys };
      if (trimmed === '') {
        delete nextKeys[endpointUrl];
      } else {
        nextKeys[endpointUrl] = trimmed;
      }
      return { ...prev, apiKeys: nextKeys };
    });
  }, []);

  const setModel = useCallback((endpointUrl: string, model: string): void => {
    update((prev) => {
      const nextModels: Record<string, string> = { ...prev.models };
      if (model === '') {
        delete nextModels[endpointUrl];
      } else {
        nextModels[endpointUrl] = model;
      }
      return { ...prev, models: nextModels };
    });
  }, []);

  const setThinkingEnabled = useCallback(
    (endpointUrl: string, enabled: boolean): void => {
      update((prev) => {
        const next: Record<string, boolean> = { ...prev.thinkingEnabled };
        if (enabled) {
          next[endpointUrl] = true;
        } else {
          delete next[endpointUrl];
        }
        return { ...prev, thinkingEnabled: next };
      });
    },
    [],
  );

  const addCustomEndpoint = useCallback((): string => {
    const id = generateId();
    update((prev) => {
      const endpoint: CustomEndpoint = { id, label: '', url: '' };
      return { ...prev, customEndpoints: [...prev.customEndpoints, endpoint] };
    });
    return id;
  }, []);

  const updateCustomEndpoint = useCallback(
    (id: string, patch: Partial<Pick<CustomEndpoint, 'label' | 'url'>>): void => {
      update((prev) => {
        const existing = prev.customEndpoints.find((e) => e.id === id);
        if (!existing) return prev;

        const nextEndpoint: CustomEndpoint = { ...existing, ...patch };
        const customEndpoints = prev.customEndpoints.map((e) =>
          e.id === id ? nextEndpoint : e,
        );

        let apiKeys = prev.apiKeys;
        let models = prev.models;
        let thinkingEnabled = prev.thinkingEnabled;
        let activeEndpoint = prev.activeEndpoint;

        if (patch.url !== undefined && patch.url !== existing.url) {
          const oldUrl = existing.url;
          const newUrl = patch.url;
          const keyForOld = oldUrl ? prev.apiKeys[oldUrl] : undefined;
          const modelForOld = oldUrl ? prev.models[oldUrl] : undefined;
          const thinkingForOld =
            oldUrl ? prev.thinkingEnabled[oldUrl] : undefined;

          if (oldUrl && oldUrl in prev.apiKeys) {
            const { [oldUrl]: _removedKey, ...restKeys } = prev.apiKeys;
            apiKeys = restKeys;
          }
          if (newUrl && keyForOld !== undefined) {
            apiKeys = { ...apiKeys, [newUrl]: keyForOld };
          }
          if (oldUrl && oldUrl in prev.models) {
            const { [oldUrl]: _removedModel, ...restModels } = prev.models;
            models = restModels;
          }
          if (newUrl && modelForOld !== undefined) {
            models = { ...models, [newUrl]: modelForOld };
          }
          if (oldUrl && oldUrl in prev.thinkingEnabled) {
            const { [oldUrl]: _removedThinking, ...restThinking } =
              prev.thinkingEnabled;
            thinkingEnabled = restThinking;
          }
          if (newUrl && thinkingForOld === true) {
            thinkingEnabled = { ...thinkingEnabled, [newUrl]: true };
          }
          if (activeEndpoint === oldUrl) {
            activeEndpoint = newUrl === '' ? null : newUrl;
          }
        }

        return {
          activeEndpoint,
          customEndpoints,
          apiKeys,
          models,
          thinkingEnabled,
        };
      });
    },
    [],
  );

  const removeCustomEndpoint = useCallback((id: string): void => {
    update((prev) => {
      const target = prev.customEndpoints.find((e) => e.id === id);
      if (!target) return prev;

      const customEndpoints = prev.customEndpoints.filter((e) => e.id !== id);
      let apiKeys = prev.apiKeys;
      let models = prev.models;
      let thinkingEnabled = prev.thinkingEnabled;
      if (target.url && target.url in prev.apiKeys) {
        const { [target.url]: _removedKey, ...restKeys } = prev.apiKeys;
        apiKeys = restKeys;
      }
      if (target.url && target.url in prev.models) {
        const { [target.url]: _removedModel, ...restModels } = prev.models;
        models = restModels;
      }
      if (target.url && target.url in prev.thinkingEnabled) {
        const { [target.url]: _removedThinking, ...restThinking } =
          prev.thinkingEnabled;
        thinkingEnabled = restThinking;
      }
      const activeEndpoint =
        prev.activeEndpoint === target.url ? null : prev.activeEndpoint;

      return {
        activeEndpoint,
        customEndpoints,
        apiKeys,
        models,
        thinkingEnabled,
      };
    });
  }, []);

  return {
    config,
    ready: hydrated,
    setActiveEndpoint,
    setApiKey,
    setModel,
    setThinkingEnabled,
    addCustomEndpoint,
    updateCustomEndpoint,
    removeCustomEndpoint,
  };
}

export default useLLMConfig;
