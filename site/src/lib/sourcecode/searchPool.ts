/**
 * Sourcecode regex search pool. Owned by Agent C.
 *
 * Spawns up to 3 module workers and round-robins manifest paths across them.
 * Workers stream `result` / `timeout` / `done` messages back; this module
 * accumulates them into a snapshot and notifies subscribers (Agent D's UI).
 *
 * The seam with Agent D is the snapshot/subscribe API and the
 * `__registerSearchImpl` hook that wires `startSearch` / `cancelSearch`
 * through to the pool.
 */

import {
  type SearchResult,
  type SearchWorkerIn,
  type SearchWorkerOut,
  type Manifest,
  OPFS_ROOT_DIR,
  OPFS_MANIFEST_FILE,
} from './types';

export type SearchState =
  | { phase: 'idle' }
  | { phase: 'searching'; total: number; done: number }
  | { phase: 'cancelled' }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

export interface SearchSnapshot {
  state: SearchState;
  results: SearchResult[];
  timeouts: string[];
}

let snapshot: SearchSnapshot = {
  state: { phase: 'idle' },
  results: [],
  timeouts: [],
};
const listeners = new Set<() => void>();

export function getSearchSnapshot(): SearchSnapshot {
  return snapshot;
}

export function subscribeSearch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSearchSnapshot(next: SearchSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

let startImpl: (pattern: string, flags: string) => void = () => {
  throw new Error('search pool not initialised');
};
let cancelImpl: () => void = () => {
  // no-op until initialised
};

export function __registerSearchImpl(impl: {
  start: (pattern: string, flags: string) => void;
  cancel: () => void;
}): void {
  startImpl = impl.start;
  cancelImpl = impl.cancel;
}

export function startSearch(pattern: string, flags: string): void {
  startImpl(pattern, flags);
}

export function cancelSearch(): void {
  cancelImpl();
}

// ---------------------------------------------------------------------------
// Pool implementation
// ---------------------------------------------------------------------------

const POOL_SIZE = Math.min(3, Math.max(1, navigator.hardwareConcurrency ?? 2));

let workers: Worker[] | null = null;
let currentSearchId = 0;
let perSearchDoneCount = 0;
let perSearchExpectedDone = 0;

function ensureWorkers(): Worker[] {
  if (workers) return workers;
  const arr: Worker[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const w = new Worker(
      new URL('../../workers/sourcecodeSearch.worker.ts', import.meta.url),
      { type: 'module' },
    );
    w.onmessage = (ev: MessageEvent<SearchWorkerOut>) => {
      handleWorkerMessage(ev.data);
    };
    arr.push(w);
  }
  workers = arr;
  return arr;
}

function handleWorkerMessage(msg: SearchWorkerOut): void {
  // Drop stale messages from previous searches.
  if (msg.id !== currentSearchId) return;

  const prev = snapshot;

  if (msg.type === 'result') {
    if (prev.state.phase !== 'searching') return;
    setSearchSnapshot({
      ...prev,
      results: prev.results.concat(msg.items),
    });
    return;
  }

  if (msg.type === 'timeout') {
    if (prev.timeouts.includes(msg.path)) return;
    setSearchSnapshot({
      ...prev,
      timeouts: prev.timeouts.concat(msg.path),
    });
    return;
  }

  if (msg.type === 'error') {
    // Per-file errors don't tear down the search; surface as a timeout-style
    // notice on the path so the UI can show that something went wrong.
    if (msg.path && !prev.timeouts.includes(msg.path)) {
      setSearchSnapshot({
        ...prev,
        timeouts: prev.timeouts.concat(msg.path),
      });
    }
    return;
  }

  if (msg.type === 'done') {
    perSearchDoneCount++;
    if (prev.state.phase === 'searching') {
      // Mark this worker's shard as fully consumed by advancing `done` to
      // `total` once every worker reports back.
      if (perSearchDoneCount >= perSearchExpectedDone) {
        setSearchSnapshot({
          ...snapshot,
          state: { phase: 'done' },
        });
      }
    } else if (
      prev.state.phase === 'cancelled' &&
      perSearchDoneCount >= perSearchExpectedDone
    ) {
      // Already cancelled; nothing else to do.
    }
    return;
  }
}

async function readManifest(): Promise<Manifest | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const scRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR);
    const manifestHandle = await scRoot.getFileHandle(OPFS_MANIFEST_FILE);
    const file = await manifestHandle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text) as Manifest;
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function start(pattern: string, flags: string): Promise<void> {
  // Validate regex on the main thread first so we can surface errors
  // synchronously without spinning up workers.
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    setSearchSnapshot({
      state: {
        phase: 'error',
        message: e instanceof Error ? e.message : String(e),
      },
      results: [],
      timeouts: [],
    });
    return;
  }

  const manifest = await readManifest();
  if (!manifest) {
    setSearchSnapshot({
      state: { phase: 'error', message: 'sourcecode not synced yet' },
      results: [],
      timeouts: [],
    });
    return;
  }

  const pool = ensureWorkers();

  currentSearchId++;
  const id = currentSearchId;
  perSearchDoneCount = 0;
  perSearchExpectedDone = pool.length;

  setSearchSnapshot({
    state: { phase: 'searching', total: manifest.length, done: 0 },
    results: [],
    timeouts: [],
  });

  // Round-robin shard the manifest across workers.
  const shards: string[][] = Array.from({ length: pool.length }, () => []);
  for (let i = 0; i < manifest.length; i++) {
    shards[i % pool.length].push(manifest[i].path);
  }

  for (let i = 0; i < pool.length; i++) {
    const msg: SearchWorkerIn = {
      type: 'search',
      request: {
        id,
        pattern,
        flags,
        paths: shards[i],
      },
    };
    pool[i].postMessage(msg);
  }
}

function cancel(): void {
  if (!workers) return;
  const id = currentSearchId;
  for (const w of workers) {
    const msg: SearchWorkerIn = { type: 'cancel', id };
    w.postMessage(msg);
  }
  const prev = snapshot;
  if (prev.state.phase === 'searching') {
    setSearchSnapshot({
      ...prev,
      state: { phase: 'cancelled' },
    });
  }
}

__registerSearchImpl({
  start: (pattern, flags) => {
    void start(pattern, flags);
  },
  cancel,
});
