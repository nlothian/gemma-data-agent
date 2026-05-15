import { isLocalGemmaEndpoint } from '../types/llm';

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const LOCAL_GEMMA_CONTEXT_WINDOW = 20_000;

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

export type PressureLevel = 'ok' | 'warn' | 'danger';

export function getPressureLevel(used: number, max: number): PressureLevel {
  const pct = max > 0 ? used / max : 0;
  if (pct >= 0.75) return 'danger';
  if (pct >= 0.6) return 'warn';
  return 'ok';
}

export const COMPACTION_THRESHOLD = 0.9;

export function shouldAutoCompact(used: number, max: number): boolean {
  return max > 0 && used / max >= COMPACTION_THRESHOLD;
}
