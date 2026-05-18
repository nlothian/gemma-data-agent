import { isBrowser } from '../browser';

export interface WebGpuStatus {
  supported: boolean;
  reason?: string;
  /**
   * The adapter's `maxBufferSize` limit in bytes, when an adapter was
   * obtained. LiteRT/MediaPipe loads Gemma weights into a single GPU storage
   * buffer; browsers that cap this low (Firefox currently pins it at 1 GiB)
   * cannot hold the model. Undefined when no adapter was available.
   */
  maxBufferSize?: number;
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
      const adapter = (await gpu.requestAdapter({ powerPreference: 'high-performance' })) as
        | { limits?: { maxBufferSize?: number } }
        | null;
      if (!adapter) {
        return {
          supported: false,
          reason: 'WebGPU adapter request returned null. No usable GPU was found.',
        };
      }
      const maxBufferSize =
        typeof adapter.limits?.maxBufferSize === 'number'
          ? adapter.limits.maxBufferSize
          : undefined;
      return { supported: true, maxBufferSize };
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
