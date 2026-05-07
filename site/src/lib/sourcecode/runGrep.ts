/**
 * Promise-shaped wrapper around the streaming `searchPool` for the explainer's
 * `GrepCodebase` tool. The pool can only run ONE search at a time (a new
 * `startSearch` cancels the previous one), so this module serialises calls
 * via an internal mutex — this lets the LLM safely fire multiple greps in a
 * single turn without them clobbering each other.
 */

import {
  cancelSearch,
  getSearchSnapshot,
  startSearch,
  subscribeSearch,
} from './searchPool';
import { ensureSourcecodeReady } from './syncStore';
import type { SearchResult } from './types';

const ALLOWED_FLAG_CHARS = /^[im]*$/;

let chain: Promise<unknown> = Promise.resolve();

function sanitiseFlags(input: string | undefined): string {
  if (!input) return '';
  if (!ALLOWED_FLAG_CHARS.test(input)) {
    throw new Error(`runGrep: only 'i' and 'm' regex flags are allowed (got "${input}")`);
  }
  return input;
}

export interface RunGrepOptions {
  pattern: string;
  flags?: string;
  /** Cap returned results to keep tool-result tokens bounded. */
  max?: number;
  signal?: AbortSignal;
}

export function runGrep(opts: RunGrepOptions): Promise<SearchResult[]> {
  const next = chain.then(() => doRunGrep(opts));
  // Swallow rejection on the chain itself so a failed search doesn't poison
  // subsequent serialised callers; each caller still gets its own real result.
  chain = next.catch(() => undefined);
  return next;
}

async function doRunGrep(opts: RunGrepOptions): Promise<SearchResult[]> {
  const flags = sanitiseFlags(opts.flags);
  const max = Math.max(1, Math.floor(opts.max ?? 50));

  if (opts.signal?.aborted) {
    throw new DOMException('grep aborted', 'AbortError');
  }

  await ensureSourcecodeReady();

  return new Promise<SearchResult[]>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let abortListener: (() => void) | null = null;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (unsubscribe) unsubscribe();
      if (abortListener && opts.signal) {
        opts.signal.removeEventListener('abort', abortListener);
      }
      fn();
    };

    if (opts.signal) {
      abortListener = () => {
        cancelSearch();
        finish(() => reject(new DOMException('grep aborted', 'AbortError')));
      };
      opts.signal.addEventListener('abort', abortListener, { once: true });
    }

    // Snapshot identity captured before `startSearch`. `setSearchSnapshot`
    // always builds a new object, so reference inequality means a transition
    // has fired — without this, the second call in a session would see the
    // previous run's terminal `'done'` snapshot and resolve with stale data.
    const initial = getSearchSnapshot();
    const check = (): void => {
      const snap = getSearchSnapshot();
      if (snap === initial) return;
      const state = snap.state;
      if (state.phase === 'done') {
        finish(() => resolve(snap.results.slice(0, max)));
      } else if (state.phase === 'error') {
        const message = state.message;
        finish(() => reject(new Error(message)));
      } else if (state.phase === 'cancelled') {
        // Another caller cancelled us — treat as empty rather than throwing,
        // so the model doesn't see a confusing error for an internal race.
        finish(() => resolve([]));
      }
    };

    unsubscribe = subscribeSearch(check);
    startSearch(opts.pattern, flags);
  });
}
