import { isLocalGemmaEndpoint } from '../types/llm';

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const LOCAL_GEMMA_CONTEXT_WINDOW = 16_384;

export function getContextWindowForEndpoint(endpoint: string | null | undefined): number {
  if (isLocalGemmaEndpoint(endpoint)) return LOCAL_GEMMA_CONTEXT_WINDOW;
  return DEFAULT_CONTEXT_WINDOW;
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}K`;
  }
  return String(n);
}
