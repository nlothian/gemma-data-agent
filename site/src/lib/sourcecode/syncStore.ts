/**
 * Sync store. Holds the current `SyncStatus`, exposes a tiny pub/sub for the
 * UI, and triggers a single in-flight sync via a Web Worker. The worker does
 * the actual fetch / unzip / OPFS write work; this module is just glue.
 */

import type { SyncStatus, SyncWorkerIn, SyncWorkerOut } from './types';

let status: SyncStatus = { phase: 'idle' };
const listeners = new Set<() => void>();
let pending: Promise<{ sha: string; fileCount: number }> | null = null;

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSyncStatus(next: SyncStatus): void {
  status = next;
  for (const listener of listeners) listener();
}

export function ensureSourcecodeReady(): Promise<{ sha: string; fileCount: number }> {
  if (pending) return pending;
  pending = runSync().catch((err) => {
    pending = null;
    throw err;
  });
  return pending;
}

// Filled in below by `__registerSyncImpl`.
let runSyncImpl: () => Promise<{ sha: string; fileCount: number }> = () =>
  Promise.reject(new Error('sourcecode sync not initialised'));

export function __registerSyncImpl(
  impl: () => Promise<{ sha: string; fileCount: number }>,
): void {
  runSyncImpl = impl;
}

function runSync(): Promise<{ sha: string; fileCount: number }> {
  return runSyncImpl();
}

// ---------------------------------------------------------------------------
// Worker-backed implementation. Registered at module load so the very first
// `ensureSourcecodeReady()` call kicks off the real sync.
// ---------------------------------------------------------------------------

async function runSyncWithWorker(): Promise<{ sha: string; fileCount: number }> {
  setSyncStatus({ phase: 'checking' });

  const worker = new Worker(
    new URL('../../workers/sourcecodeSync.worker.ts', import.meta.url),
    { type: 'module' },
  );

  return new Promise<{ sha: string; fileCount: number }>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<SyncWorkerOut>) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        setSyncStatus({
          phase: msg.phase === 'fetch' ? 'fetching' : 'unzipping',
          progress: { done: msg.done, total: msg.total },
        });
      } else if (msg.type === 'ready') {
        setSyncStatus({ phase: 'ready', sha: msg.sha, fileCount: msg.fileCount });
        worker.terminate();
        resolve({ sha: msg.sha, fileCount: msg.fileCount });
      } else if (msg.type === 'error') {
        setSyncStatus({ phase: 'error', error: msg.message });
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (ev) => {
      const parts = [
        ev.message,
        ev.filename ? `at ${ev.filename}:${ev.lineno}:${ev.colno}` : null,
      ].filter(Boolean);
      const message = parts.length
        ? parts.join(' ')
        : 'sourcecode sync worker errored (no message — check DevTools console)';
      setSyncStatus({ phase: 'error', error: message });
      worker.terminate();
      reject(new Error(message));
    };
    worker.postMessage({ type: 'sync' } satisfies SyncWorkerIn);
  });
}

__registerSyncImpl(runSyncWithWorker);
