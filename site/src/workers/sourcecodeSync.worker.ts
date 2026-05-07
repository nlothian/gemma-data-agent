/// <reference lib="webworker" />
/**
 * Sourcecode sync worker.
 *
 * Compares the server-side `/sourcecode.sha` against the SHA recorded in OPFS
 * at `sourcecode/.sha`. If they match (and a manifest also exists), reports
 * ready immediately. Otherwise downloads `/sourcecode.zip`, unzips it, wipes
 * the existing OPFS tree under `sourcecode/files/`, writes every entry to
 * `sourcecode/files/<entry-key>`, writes a `manifest.json`, and finally
 * writes `.sha` (so a partial sync never looks "ready").
 */

import { unzipSync } from 'fflate';
import {
  type SyncWorkerOut,
  type SyncWorkerIn,
  type Manifest,
  OPFS_ROOT_DIR,
  OPFS_FILES_DIR,
  OPFS_SHA_FILE,
  OPFS_MANIFEST_FILE,
  SHA_URL,
  ZIP_URL,
} from '../lib/sourcecode/types';

declare const self: DedicatedWorkerGlobalScope;

const PROGRESS_BYTES = 64 * 1024;
const PROGRESS_FILES = 50;

function post(msg: SyncWorkerOut): void {
  self.postMessage(msg);
}

async function readShaIfExists(
  scRoot: FileSystemDirectoryHandle,
): Promise<string | null> {
  try {
    const handle = await scRoot.getFileHandle(OPFS_SHA_FILE);
    const file = await handle.getFile();
    const text = await file.text();
    return text.trim();
  } catch {
    return null;
  }
}

async function manifestExists(
  scRoot: FileSystemDirectoryHandle,
): Promise<boolean> {
  try {
    await scRoot.getFileHandle(OPFS_MANIFEST_FILE);
    return true;
  } catch {
    return false;
  }
}

async function fetchZipBytes(): Promise<Uint8Array> {
  const resp = await fetch(ZIP_URL);
  if (!resp.ok || !resp.body) {
    throw new Error(`Failed to fetch ${ZIP_URL}: ${resp.status} ${resp.statusText}`);
  }
  const total = Number(resp.headers.get('Content-Length') ?? 0) || 0;
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  let sinceLastReport = 0;

  post({ type: 'progress', phase: 'fetch', done: 0, total });

  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    if (value) {
      chunks.push(value);
      done += value.length;
      sinceLastReport += value.length;
      if (sinceLastReport >= PROGRESS_BYTES) {
        post({ type: 'progress', phase: 'fetch', done, total });
        sinceLastReport = 0;
      }
    }
  }
  post({ type: 'progress', phase: 'fetch', done, total: total || done });

  // Concatenate chunks into a single Uint8Array.
  const buf = await new Blob(chunks as BlobPart[]).arrayBuffer();
  return new Uint8Array(buf);
}

type MaybeSyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<FileSystemSyncAccessHandle>;
};

async function writeFileBytes(
  fileHandle: FileSystemFileHandle,
  bytes: Uint8Array,
): Promise<void> {
  const anyHandle = fileHandle as MaybeSyncFileHandle;
  // Detach from the (possibly SharedArrayBuffer-backed) generic Uint8Array
  // type by wrapping in a fresh ArrayBuffer-backed view. This keeps the
  // FileSystem*Handle method signatures happy under TS lib.dom.
  const ab = new ArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(ab);
  view.set(bytes);

  if (typeof anyHandle.createSyncAccessHandle === 'function') {
    const sync = await anyHandle.createSyncAccessHandle();
    try {
      sync.truncate(0);
      sync.write(view, { at: 0 });
      sync.flush();
    } finally {
      sync.close();
    }
    return;
  }
  // Fallback: async writable stream.
  const writable = await fileHandle.createWritable();
  await writable.write(view);
  await writable.close();
}

async function ensureDirPath(
  filesRoot: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = filesRoot;
  for (const seg of segments) {
    if (!seg) continue;
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

async function wipeExisting(scRoot: FileSystemDirectoryHandle): Promise<void> {
  try {
    await scRoot.removeEntry(OPFS_FILES_DIR, { recursive: true });
  } catch {
    // ignore
  }
  try {
    await scRoot.removeEntry(OPFS_SHA_FILE);
  } catch {
    // ignore
  }
  try {
    await scRoot.removeEntry(OPFS_MANIFEST_FILE);
  } catch {
    // ignore
  }
}

async function runSync(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const scRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: true });

  const existingSha = await readShaIfExists(scRoot);

  const shaResp = await fetch(SHA_URL);
  if (!shaResp.ok) {
    throw new Error(`Failed to fetch ${SHA_URL}: ${shaResp.status} ${shaResp.statusText}`);
  }
  const serverSha = (await shaResp.text()).trim();

  if (existingSha && existingSha === serverSha && (await manifestExists(scRoot))) {
    // Best-effort: report the cached file count by reading the manifest.
    let fileCount = 0;
    try {
      const manifestHandle = await scRoot.getFileHandle(OPFS_MANIFEST_FILE);
      const file = await manifestHandle.getFile();
      const parsed = JSON.parse(await file.text()) as Manifest;
      fileCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      // fall through with 0
    }
    post({ type: 'ready', sha: serverSha, fileCount });
    return;
  }

  const zipBytes = await fetchZipBytes();

  post({ type: 'progress', phase: 'unzip', done: 0, total: 0 });
  const entries = unzipSync(zipBytes);
  const entryList = Object.entries(entries).filter(([path]) => !path.endsWith('/'));
  const total = entryList.length;

  await wipeExisting(scRoot);
  const filesRoot = await scRoot.getDirectoryHandle(OPFS_FILES_DIR, { create: true });

  const manifest: Manifest = [];
  let done = 0;
  for (const [path, bytes] of entryList) {
    const segs = path.split('/');
    const fileName = segs.pop() as string;
    const dir = await ensureDirPath(filesRoot, segs);
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    await writeFileBytes(fileHandle, bytes);
    manifest.push({ path, size: bytes.length });
    done += 1;
    if (done % PROGRESS_FILES === 0) {
      post({ type: 'progress', phase: 'unzip', done, total });
    }
  }
  post({ type: 'progress', phase: 'unzip', done, total });

  // Write manifest.json.
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestHandle = await scRoot.getFileHandle(OPFS_MANIFEST_FILE, { create: true });
  await writeFileBytes(manifestHandle, manifestBytes);

  // Write .sha LAST so a crash mid-write never leaves a "looks ready" state.
  const shaBytes = new TextEncoder().encode(serverSha);
  const shaHandle = await scRoot.getFileHandle(OPFS_SHA_FILE, { create: true });
  await writeFileBytes(shaHandle, shaBytes);

  post({ type: 'ready', sha: serverSha, fileCount: manifest.length });
}

self.onmessage = async (ev: MessageEvent<SyncWorkerIn>) => {
  if (ev.data?.type !== 'sync') return;
  try {
    await runSync();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
    post({ type: 'error', message });
  }
};
