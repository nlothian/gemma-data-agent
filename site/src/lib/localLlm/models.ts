export type LocalGemmaId = 'gemma-4-e2b' | 'gemma-4-e4b';

export interface LocalGemmaModel {
  id: LocalGemmaId;
  label: string;
  url: string;
  approxBytes: number;
}

export const LOCAL_GEMMA_MODELS: readonly LocalGemmaModel[] = [
  {
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task',
    approxBytes: 1_400_000_000,
  },
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B',
    url: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.task',
    approxBytes: 3_100_000_000,
  },
];

export const DEFAULT_LOCAL_GEMMA_ID: LocalGemmaId = 'gemma-4-e2b';

export function getLocalGemmaModel(id: string | null | undefined): LocalGemmaModel | undefined {
  if (!id) return undefined;
  return LOCAL_GEMMA_MODELS.find((m) => m.id === id);
}

export function formatGB(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
