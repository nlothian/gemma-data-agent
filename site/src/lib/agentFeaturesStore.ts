/**
 * External store for the agent feature flags. Shared between the chat sidebar
 * (which builds the system prompt and tool list) and the execution panel
 * (which hides tabs whose feature is unchecked) — the two are separate React
 * islands, so they synchronise through this store rather than props.
 */

import type { AgentPromptFeatures } from './agentTools';

const STORAGE_KEY = 'agentFeatures';

const DEFAULT_FEATURES: AgentPromptFeatures = {
  dataLoading: true,
  runSql: true,
  runPython: true,
  runReact: true,
  runSubAgent: true,
};

function load(): AgentPromptFeatures {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_FEATURES };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { ...DEFAULT_FEATURES };
  try {
    const parsed = JSON.parse(raw) as Partial<AgentPromptFeatures>;
    return {
      dataLoading: parsed.dataLoading ?? true,
      runSql: parsed.runSql ?? true,
      runPython: parsed.runPython ?? true,
      runReact: parsed.runReact ?? true,
      runSubAgent: parsed.runSubAgent ?? true,
    };
  } catch {
    return { ...DEFAULT_FEATURES };
  }
}

let snapshot: AgentPromptFeatures | null = null;
const listeners = new Set<() => void>();

function ensureLoaded(): AgentPromptFeatures {
  if (snapshot === null) snapshot = load();
  return snapshot;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): AgentPromptFeatures {
  return ensureLoaded();
}

export function getServerSnapshot(): AgentPromptFeatures {
  return DEFAULT_FEATURES;
}

export function getFeatures(): AgentPromptFeatures {
  return ensureLoaded();
}

export function setFeature(
  key: keyof AgentPromptFeatures,
  value: boolean,
): void {
  const current = ensureLoaded();
  if (current[key] === value) return;
  snapshot = { ...current, [key]: value };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  for (const listener of listeners) listener();
}
