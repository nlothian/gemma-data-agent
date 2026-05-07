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
    const lines = text.split(/\r?\n/);
    let timedOut = false;
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (performance.now() - start > 250) {
        timedOut = true;
        break;
      }
      const lineText = lines[lineIdx];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
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
      }
    }
    if (timedOut) {
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
