import {
  DEFAULT_LOCAL_GEMMA_ID,
  getLocalGemmaModel,
  type LocalGemmaModel,
} from './models';
import { LOCAL_GEMMA_ENDPOINT, type LLMConfig } from '../../types/llm';

export interface CustomLocalModel {
  id: string;
  label: string;
  file: File;
}

export type ActiveLocalModel =
  | { kind: 'predefined'; label: string; model: LocalGemmaModel }
  | { kind: 'custom'; label: string; model: CustomLocalModel };

const customModels = new Map<string, CustomLocalModel>();
const listeners = new Set<() => void>();

// Referentially-stable snapshot, rebuilt only on mutation, so it is safe to
// feed directly to React's `useSyncExternalStore` (which requires the
// snapshot to be cached between notifications).
let snapshot: readonly CustomLocalModel[] = [];

function notify(): void {
  snapshot = Array.from(customModels.values());
  for (const cb of listeners) cb();
}

function stripTaskExtension(name: string): string {
  return name.endsWith('.task') ? name.slice(0, -'.task'.length) : name;
}

export function prettyLabelFromFilename(name: string): string {
  return stripTaskExtension(name)
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s.slice(0, 1).toUpperCase() + s.slice(1))
    .join(' ');
}

export function registerCustomModel(file: File): CustomLocalModel {
  const id = `custom:${stripTaskExtension(file.name)}`;
  const model: CustomLocalModel = {
    id,
    label: prettyLabelFromFilename(file.name),
    file,
  };
  customModels.set(id, model);
  notify();
  return model;
}

export function getCustomModel(
  id: string | null | undefined,
): CustomLocalModel | undefined {
  if (!id) return undefined;
  return customModels.get(id);
}

export function resolveActiveLocalModel(
  id: string | null | undefined,
): ActiveLocalModel | undefined {
  const pre = getLocalGemmaModel(id);
  if (pre) return { kind: 'predefined', label: pre.label, model: pre };
  const cus = getCustomModel(id);
  if (cus) return { kind: 'custom', label: cus.label, model: cus };
  return undefined;
}

export function subscribeCustomModels(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getCustomModelsSnapshot(): readonly CustomLocalModel[] {
  return snapshot;
}

/**
 * The single source of truth for "which local Gemma model id is active",
 * applying the default fallback. Used by every local-inference entry point
 * (`streamLocalGemma`, `summariseCode`, `compactConversation`) and the
 * boot-time eager-load so they all resolve the same id. Returns a value that
 * `resolveActiveLocalModel` is guaranteed to resolve: the stored id when it
 * resolves (predefined or a registered custom model), else
 * `DEFAULT_LOCAL_GEMMA_ID`.
 */
export function resolveActiveLocalModelIdOrDefault(config: LLMConfig): string {
  const requested =
    config.models[LOCAL_GEMMA_ENDPOINT] ?? DEFAULT_LOCAL_GEMMA_ID;
  return resolveActiveLocalModel(requested) ? requested : DEFAULT_LOCAL_GEMMA_ID;
}
