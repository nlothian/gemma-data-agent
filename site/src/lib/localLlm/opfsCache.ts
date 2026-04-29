/**
 * Adapted from mediapipe-samples/examples/llm_inference/llm_chat_ts/src/opfs_cache.ts
 * (Apache 2.0). Trimmed for our use: no HuggingFace OAuth, no rxjs.
 */

export interface ProgressUpdate {
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
}

type ProgressListener = (p: ProgressUpdate) => void;

export interface ProgressEmitter {
  subscribe(cb: ProgressListener): () => void;
  emit(p: ProgressUpdate): void;
  complete(): void;
}

function createEmitter(): ProgressEmitter {
  const listeners = new Set<ProgressListener>();
  return {
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    emit(p) {
      for (const fn of listeners) fn(p);
    },
    complete() {
      listeners.clear();
    },
  };
}

function getFileName(url: string): string {
  const lastSlash = url.lastIndexOf('/');
  return lastSlash === -1 ? url : url.slice(lastSlash + 1);
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return null;
  }
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

export async function isModelCached(url: string): Promise<boolean> {
  const root = await getOpfsRoot();
  if (!root) return false;
  const fileName = getFileName(url);
  try {
    const fileHandle = await root.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    const sizeHandle = await root.getFileHandle(fileName + '_size');
    const sizeFile = await sizeHandle.getFile();
    const expected = parseInt(await sizeFile.text(), 10);
    return Number.isFinite(expected) && expected > 0 && file.size === expected;
  } catch {
    return false;
  }
}

export async function loadModelWithCache(
  url: string,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number; fromCache: boolean }> {
  const root = await getOpfsRoot();
  const fileName = getFileName(url);

  if (root) {
    try {
      const fileHandle = await root.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const sizeHandle = await root.getFileHandle(fileName + '_size');
      const sizeFile = await sizeHandle.getFile();
      const expected = parseInt(await sizeFile.text(), 10);
      if (Number.isFinite(expected) && expected > 0 && file.size === expected) {
        return { stream: file.stream(), size: file.size, fromCache: true };
      }
      try {
        await root.removeEntry(fileName);
      } catch {
        // ignore
      }
      try {
        await root.removeEntry(fileName + '_size');
      } catch {
        // ignore
      }
    } catch {
      // not cached — fall through
    }
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download model: ${response.status} ${response.statusText}`);
  }
  const expectedSize = Number(response.headers.get('Content-Length') ?? 0);
  if (!Number.isFinite(expectedSize) || expectedSize <= 0) {
    throw new Error('Server did not return a valid Content-Length for the model.');
  }

  if (root) {
    if (typeof navigator.storage?.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        const free = (est.quota ?? 0) - (est.usage ?? 0);
        if (expectedSize > free) {
          // eslint-disable-next-line no-alert
          alert(
            `The browser reports it does not have enough cache space for this model. ` +
              `Model size: ${expectedSize}. Free: ${free}.`,
          );
        }
      } catch {
        // ignore
      }
    }

    const [streamForConsumer, streamForCache] = response.body.tee();

    void (async () => {
      try {
        const fileHandle = await root.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();

        const sizeHandle = await root.getFileHandle(fileName + '_size', { create: true });
        const sizeWritable = await sizeHandle.createWritable();
        const sizeWriter = sizeWritable.getWriter();
        await sizeWriter.write(new TextEncoder().encode(String(expectedSize)));
        await sizeWriter.close();

        await streamForCache.pipeTo(writable);
      } catch (err) {
        console.warn('OPFS caching failed:', err);
        try {
          await root.removeEntry(fileName);
        } catch {
          // ignore
        }
        try {
          await root.removeEntry(fileName + '_size');
        } catch {
          // ignore
        }
      }
    })();

    return { stream: streamForConsumer, size: expectedSize, fromCache: false };
  }

  return { stream: response.body, size: expectedSize, fromCache: false };
}

export function streamWithProgress(
  input: ReadableStream<Uint8Array>,
  total: number,
): { stream: ReadableStream<Uint8Array>; progress: ProgressEmitter } {
  const progress = createEmitter();
  let read = 0;
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      read += chunk.length;
      progress.emit({
        progress: total > 0 ? read / total : 0,
        downloadedBytes: read,
        totalBytes: total,
      });
      controller.enqueue(chunk);
    },
    flush() {
      progress.emit({ progress: 1, downloadedBytes: total, totalBytes: total });
      progress.complete();
    },
  });
  const stream = input.pipeThrough(transformer);
  return { stream, progress };
}
