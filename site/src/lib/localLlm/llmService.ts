/**
 * Singleton wrapper around MediaPipe's LlmInference for the in-browser Gemma 4
 * provider. Loads the model task file via OPFS cache and exposes a small
 * promise/callback API for `streamLocalGemma`.
 *
 * Patterns adapted from mediapipe-samples/.../llm_service.ts (Apache 2.0).
 */

import { setLocalLlmDownloadProgress } from '../executionPanelStore';
import { LOCAL_GEMMA_CONTEXT_WINDOW } from '../contextWindow';
import {
  getLocalGemmaModel,
  type LocalGemmaId,
  type LocalGemmaModel,
} from './models';
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
  close?: () => void;
  sizeInTokens?: (text: string) => number | null;
}

let mediapipePromise: Promise<MediapipeModule> | null = null;
let filesetPromise: Promise<unknown> | null = null;

let currentModel: LocalGemmaModel | null = null;
let currentLoadPromise: Promise<LlmInferenceLike> | null = null;
let currentInference: LlmInferenceLike | null = null;
let currentLoadId = 0;

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

export async function ensureLoaded(modelId: LocalGemmaId): Promise<void> {
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

  const model = getLocalGemmaModel(modelId);
  if (!model) {
    throw new Error(`Unknown local Gemma model: ${modelId}`);
  }

  const loadId = ++currentLoadId;
  currentModel = model;

  currentLoadPromise = (async (): Promise<LlmInferenceLike> => {
    const [mp, fileset] = await Promise.all([loadMediapipe(), loadFileset()]);

    const { stream, size, fromCache } = await loadModelWithCache(model.url);
    const { stream: progressStream, progress } = streamWithProgress(stream, size);

    setLocalLlmDownloadProgress({ label: model.label, pct: 0, fromCache });
    const unsub = progress.subscribe((p: ProgressUpdate) => {
      if (loadId !== currentLoadId) return;
      setLocalLlmDownloadProgress({
        label: model.label,
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

function isInputTooLongError(err: unknown): boolean {
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
  const inference = currentInference;
  if (!inference) {
    throw new Error('Local Gemma model is not loaded. Call ensureLoaded() first.');
  }

  return await new Promise<string>((resolve, reject) => {
    let aggregated = '';
    let aborted = false;

    const onAbort = (): void => {
      aborted = true;
      try {
        inference.cancelProcessing?.();
      } catch {
        // ignore
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        resolve(aggregated);
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      inference.generateResponse(prompt, (partial, done) => {
        if (aborted) return;
        if (partial) {
          aggregated += partial;
          try {
            onToken(partial, done);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        if (done) {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(aggregated);
        }
      });
    } catch (err) {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (isInputTooLongError(err)) {
        console.log('[llmService] Input too long for model. Prompt was:\n', prompt);
      }
      reject(err instanceof Error ? err : new Error(String(err)));
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
