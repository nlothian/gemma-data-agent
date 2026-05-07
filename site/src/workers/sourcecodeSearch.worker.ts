/**
 * Sourcecode regex search worker. Owned by Agent C.
 *
 * Receives a `search` request with a shard of paths to scan against an OPFS
 * tree under `sourcecode/files/`. Streams results in batches and reports
 * per-file timeouts. A `cancel` message aborts the in-flight loop.
 */

import type {
  SearchWorkerIn,
  SearchWorkerOut,
  SearchResult,
} from '../lib/sourcecode/types';

let abortFlag: { id: number; aborted: boolean } = { id: 0, aborted: false };

function ensureGlobal(flags: string): string {
  return flags.includes('g') ? flags : flags + 'g';
}

function postOut(msg: SearchWorkerOut): void {
  (self as unknown as Worker).postMessage(msg);
}

async function runSearch(request: {
  id: number;
  pattern: string;
  flags: string;
  paths: string[];
}): Promise<void> {
  abortFlag = { id: request.id, aborted: false };

  let re: RegExp;
  try {
    re = new RegExp(request.pattern, ensureGlobal(request.flags));
  } catch (e) {
    postOut({
      type: 'error',
      id: request.id,
      path: '',
      message: e instanceof Error ? e.message : String(e),
    });
    postOut({ type: 'done', id: request.id });
    return;
  }

  let filesRoot: FileSystemDirectoryHandle;
  try {
    const root = await navigator.storage.getDirectory();
    const scRoot = await root.getDirectoryHandle('sourcecode');
    filesRoot = await scRoot.getDirectoryHandle('files');
  } catch (e) {
    postOut({
      type: 'error',
      id: request.id,
      path: '',
      message: e instanceof Error ? e.message : String(e),
    });
    postOut({ type: 'done', id: request.id });
    return;
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let batch: SearchResult[] = [];
  let lastFlush = performance.now();

  const flush = (): void => {
    if (batch.length === 0) return;
    postOut({ type: 'result', id: request.id, items: batch });
    batch = [];
    lastFlush = performance.now();
  };

  for (const path of request.paths) {
    if (abortFlag.aborted && abortFlag.id === request.id) break;

    const segments = path.split('/');
    let dir: FileSystemDirectoryHandle | null = filesRoot;
    for (let i = 0; i < segments.length - 1; i++) {
      try {
        dir = await dir.getDirectoryHandle(segments[i]);
      } catch {
        dir = null;
        break;
      }
    }
    if (!dir) continue;

    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
    } catch {
      continue;
    }

    let bytes: Uint8Array;
    try {
      const fh = fileHandle as FileSystemFileHandle & {
        createSyncAccessHandle?: () => Promise<{
          getSize: () => number;
          read: (buf: Uint8Array, opts: { at: number }) => number;
          close: () => void;
        }>;
      };
      if (typeof fh.createSyncAccessHandle === 'function') {
        const h = await fh.createSyncAccessHandle();
        const size = h.getSize();
        const buf = new Uint8Array(size);
        h.read(buf, { at: 0 });
        h.close();
        bytes = buf;
      } else {
        const file = await fileHandle.getFile();
        bytes = new Uint8Array(await file.arrayBuffer());
      }
    } catch {
      continue;
    }

    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      continue;
    }

    const start = performance.now();
    const deadline = start + 250;
    const lines = text.split(/\r?\n/);
    // WHY: lines longer than this are almost always minified/binary-ish blobs
    // that turn pathological regexes (e.g. `(a+)+$`) into multi-second hangs.
    // Skip them and treat the whole file as timed-out so the UI flags it.
    const MAX_LINE_LEN = 4096;
    // WHY: regex.exec runs synchronously without preemption, so we must
    // re-check the deadline every few iterations of the inner loop. A
    // catastrophic-backtrack pattern can otherwise wedge the worker for
    // seconds inside a single exec() call between line-level checks.
    const MATCH_CHECK_EVERY = 64;
    let timedOut = false;
    outer: for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (performance.now() > deadline) {
        timedOut = true;
        break;
      }
      const lineText = lines[lineIdx];
      // WHY: cap line length before regex executes — preempts ReDoS on huge
      // single-line payloads (minified bundles, accidental binaries).
      if (lineText.length > MAX_LINE_LEN) {
        timedOut = true;
        break;
      }
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let matchCount = 0;
      while ((m = re.exec(lineText)) !== null) {
        batch.push({
          path,
          line: lineIdx + 1,
          col: m.index + 1,
          lineText:
            lineText.length > 500 ? lineText.slice(0, 500) + '…' : lineText,
          matchStart: m.index,
          matchEnd: m.index + m[0].length,
        });
        if (m[0].length === 0) re.lastIndex++;
        if (!re.global) break;
        matchCount++;
        // WHY: per-match deadline check so a runaway exec()-loop on one line
        // can't burn through the whole 250ms budget invisibly.
        if (matchCount % MATCH_CHECK_EVERY === 0 && performance.now() > deadline) {
          timedOut = true;
          break outer;
        }
      }
    }
    if (timedOut) {
      // WHY: reuse the existing `timeout` signal so the UI flags this file as
      // skipped (covers both true 250ms timeouts and oversized-line skips).
      postOut({ type: 'timeout', id: request.id, path });
    }

    if (batch.length >= 50 || performance.now() - lastFlush > 100) {
      flush();
    }
  }

  flush();
  postOut({ type: 'done', id: request.id });
}

self.addEventListener('message', (ev: MessageEvent<SearchWorkerIn>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    if (msg.id === abortFlag.id) {
      abortFlag.aborted = true;
    }
    return;
  }
  if (msg.type === 'search') {
    void runSearch(msg.request);
  }
});

export {};
