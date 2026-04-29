import { isBrowser } from '../browser';

export interface WebGpuStatus {
  supported: boolean;
  reason?: string;
}

let cached: WebGpuStatus | null = null;
let inflight: Promise<WebGpuStatus> | null = null;

export function isWebGpuApiPresent(): boolean {
  if (!isBrowser()) return false;
  return typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined';
}

export async function detectWebGpu(): Promise<WebGpuStatus> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async (): Promise<WebGpuStatus> => {
    if (!isBrowser()) {
      return { supported: false, reason: 'WebGPU is unavailable outside the browser.' };
    }
    const gpu = (navigator as unknown as { gpu?: { requestAdapter: (opts?: unknown) => Promise<unknown> } }).gpu;
    if (!gpu) {
      return {
        supported: false,
        reason: 'WebGPU is not exposed by this browser. Use a recent Chrome or Edge.',
      };
    }
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        return {
          supported: false,
          reason: 'WebGPU adapter request returned null. No usable GPU was found.',
        };
      }
      return { supported: true };
    } catch (err) {
      return {
        supported: false,
        reason: `WebGPU adapter request failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  })();

  try {
    cached = await inflight;
    return cached;
  } finally {
    inflight = null;
  }
}
