import {
  getLocalGemmaModel,
  type LocalGemmaModel,
} from './models';

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

function notify(): void {
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
  return Array.from(customModels.values());
}
