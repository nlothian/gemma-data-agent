/**
 * Singleton wrapper around MediaPipe's LlmInference for the in-browser Gemma 4
 * provider. Loads the model task file via OPFS cache and exposes a small
 * promise/callback API for `streamLocalGemma`.
 *
 * Patterns adapted from mediapipe-samples/.../llm_service.ts (Apache 2.0).
 */

import { setLocalLlmDownloadProgress } from '../executionPanelStore';
import { LOCAL_GEMMA_CONTEXT_WINDOW } from '../contextWindow';
import { resolveActiveLocalModel } from './customModels';
import {
  loadModelWithCache,
  streamWithProgress,
  type ProgressUpdate,
} from './opfsCache';

const MEDIAPIPE_VERSION = '0.10.27';
const WASM_FILESET_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai@${MEDIAPIPE_VERSION}/wasm`;

interface MediapipeModule {
  FilesetResolver: {
    forGenAiTasks: (path: string) => Promise<unknown>;
  };
  LlmInference: {
    createFromOptions: (fileset: unknown, options: unknown) => Promise<LlmInferenceLike>;
  };
}

interface LlmInferenceLike {
  generateResponse: (
    prompt: string,
    onUpdate: (partial: string, done: boolean) => void,
  ) => void;
  cancelProcessing?: () => void;
  clearCancelSignals?: () => void;
  close?: () => void;
  sizeInTokens?: (text: string) => number | null;
}

let mediapipePromise: Promise<MediapipeModule> | null = null;
let filesetPromise: Promise<unknown> | null = null;

let currentModel: { id: string; label: string } | null = null;
let currentLoadPromise: Promise<LlmInferenceLike> | null = null;
let currentInference: LlmInferenceLike | null = null;
let currentLoadId = 0;

// Tracks an in-flight `generateResponse` invocation. MediaPipe rejects a new
// `generateResponse` call with "Previous invocation or loading is still
// ongoing" until its callback has fired with `done=true`. Callers must await
// this before issuing a new generation. Resolves regardless of how the prior
// generation ended (normal, abort, callback throw).
let pendingGeneration: Promise<void> | null = null;
const GENERATION_WIND_DOWN_MS = 500;

async function loadMediapipe(): Promise<MediapipeModule> {
  if (!mediapipePromise) {
    mediapipePromise = import('@mediapipe/tasks-genai') as unknown as Promise<MediapipeModule>;
  }
  return mediapipePromise;
}

async function loadFileset(): Promise<unknown> {
  if (!filesetPromise) {
    filesetPromise = (async () => {
      const mp = await loadMediapipe();
      return mp.FilesetResolver.forGenAiTasks(WASM_FILESET_URL);
    })();
  }
  return filesetPromise;
}

export async function ensureLoaded(modelId: string): Promise<void> {
  if (currentInference && currentModel?.id === modelId) return;
  if (currentLoadPromise && currentModel?.id === modelId) {
    await currentLoadPromise;
    return;
  }

  if (currentInference && currentModel?.id !== modelId) {
    try {
      currentInference.close?.();
    } catch {
      // ignore
    }
    currentInference = null;
    currentModel = null;
  }

  const resolved = resolveActiveLocalModel(modelId);
  if (!resolved) {
    throw new Error(`Unknown local model: ${modelId}`);
  }

  const loadId = ++currentLoadId;
  const label = resolved.label;
  currentModel = { id: modelId, label };

  currentLoadPromise = (async (): Promise<LlmInferenceLike> => {
    const [mp, fileset] = await Promise.all([loadMediapipe(), loadFileset()]);

    let stream: ReadableStream<Uint8Array>;
    let size: number;
    let fromCache: boolean;
    if (resolved.kind === 'predefined') {
      ({ stream, size, fromCache } = await loadModelWithCache(resolved.model.url));
    } else {
      // User-supplied .task — already on disk, skip OPFS entirely.
      stream = resolved.model.file.stream();
      size = resolved.model.file.size;
      fromCache = true;
    }
    const { stream: progressStream, progress } = streamWithProgress(stream, size);

    setLocalLlmDownloadProgress({ label, pct: 0, fromCache });
    const unsub = progress.subscribe((p: ProgressUpdate) => {
      if (loadId !== currentLoadId) return;
      setLocalLlmDownloadProgress({
        label,
        pct: Math.round(p.progress * 100),
        fromCache,
      });
    });

    try {
      const reader = progressStream.getReader();
      const inference = await mp.LlmInference.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: reader },
        maxTokens: LOCAL_GEMMA_CONTEXT_WINDOW,
        topK: 40,
        temperature: 0.8,
        randomSeed: 1,
        numResponses: 1,
      });
      if (loadId !== currentLoadId) {
        try {
          inference.close?.();
        } catch {
          // ignore
        }
        throw new Error('Model load superseded.');
      }
      currentInference = inference;
      return inference;
    } finally {
      unsub();
      if (loadId === currentLoadId) {
        setLocalLlmDownloadProgress(null);
      }
    }
  })();

  try {
    await currentLoadPromise;
  } finally {
    if (loadId === currentLoadId) {
      currentLoadPromise = null;
    }
  }
}

export function isInputTooLongError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.includes('Input is too long for the model to process');
}

export interface GenerateOptions {
  prompt: string;
  signal?: AbortSignal;
  onToken: (delta: string, done: boolean) => void;
}

export async function generate(opts: GenerateOptions): Promise<string> {
  const { prompt, signal, onToken } = opts;

  // Wait for any prior generation to fully wind down inside MediaPipe before
  // issuing a new one — otherwise the SDK throws "Previous invocation or
  // loading is still ongoing".
  if (pendingGeneration) {
    try {
      await pendingGeneration;
    } catch {
      // ignore — the prior generation's caller already saw its error
    }
  }

  const inference = currentInference;
  if (!inference) {
    throw new Error('Local Gemma model is not loaded. Call ensureLoaded() first.');
  }

  // Reset MediaPipe's internal cancel flag before issuing a new decode. If the
  // prior generation was cut short by `cancelProcessing()` (e.g. when the
  // streaming parser detected a tool call), leaving the cancel signal set
  // causes the next `generateResponse` to fail with a packet-timestamp
  // mismatch on the `token_cost_in` calculator stream.
  try {
    inference.clearCancelSignals?.();
  } catch {
    // ignore — never block a generation on a reset failure
  }

  let resolveMpDone: () => void = () => {};
  const mpDone = new Promise<void>((resolve) => {
    resolveMpDone = resolve;
  });
  pendingGeneration = mpDone;
  void mpDone.finally(() => {
    if (pendingGeneration === mpDone) pendingGeneration = null;
  });

  return await new Promise<string>((resolve, reject) => {
    let aggregated = '';
    let aborted = false;
    let settled = false;
    let windDownTimer: ReturnType<typeof setTimeout> | null = null;

    const settleOk = (): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(aggregated);
    };
    const settleErr = (err: unknown): void => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const armWindDown = (settleAs: 'ok' | null): void => {
      if (windDownTimer !== null) return;
      windDownTimer = setTimeout(() => {
        windDownTimer = null;
        resolveMpDone();
        if (settleAs === 'ok') settleOk();
      }, GENERATION_WIND_DOWN_MS);
    };
    const clearWindDown = (): void => {
      if (windDownTimer !== null) {
        clearTimeout(windDownTimer);
        windDownTimer = null;
      }
    };

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      try {
        inference.cancelProcessing?.();
      } catch {
        // ignore
      }
      // Don't resolve the caller's promise yet — MediaPipe still owes us a
      // `done=true` callback. Arm a watchdog so a misbehaving SDK can't
      // deadlock the next generation or hang this caller.
      armWindDown('ok');
    };

    if (signal) {
      if (signal.aborted) {
        // Already aborted — MediaPipe was never invoked, so release both the
        // lifecycle gate and the caller immediately.
        resolveMpDone();
        settleOk();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      inference.generateResponse(prompt, (partial, done) => {
        if (partial && !aborted) {
          aggregated += partial;
          try {
            onToken(partial, done);
          } catch (err) {
            try {
              inference.cancelProcessing?.();
            } catch {
              // ignore
            }
            // Settle the caller now with the throw; let the watchdog clear
            // the lifecycle gate once MediaPipe has had a chance to wind
            // down (or after the timeout).
            settleErr(err);
            armWindDown(null);
            return;
          }
        }
        if (done) {
          clearWindDown();
          resolveMpDone();
          settleOk();
        }
      });
    } catch (err) {
      if (isInputTooLongError(err)) {
        console.log('[llmService] Input too long for model. Prompt was:\n', prompt);
      }
      // Synchronous throw means MediaPipe never started — release the
      // lifecycle gate immediately.
      resolveMpDone();
      settleErr(err);
    }
  });
}

export function sizeInTokens(text: string): number | null {
  const inf = currentInference;
  if (!inf?.sizeInTokens) return null;
  try {
    const n = inf.sizeInTokens(text);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function cancel(): void {
  try {
    currentInference?.cancelProcessing?.();
  } catch {
    // ignore
  }
}
