/**
 * Workspace = a user-picked local directory used by the data-gen mode for
 * inputs (datasets, task corpora) and outputs (sft.jsonl, dpo.jsonl, run logs).
 *
 * The directory handle survives across reloads via IndexedDB. On every
 * resume we re-verify permission, since browsers may downgrade granted
 * permissions silently.
 */

const DB_NAME = 'haw.datagen.v1';
const STORE = 'handles';
const HANDLE_KEY = 'workspaceRoot';

type AnyDirHandle = FileSystemDirectoryHandle & {
  // Chromium-only permission methods — typed loosely because lib.dom.d.ts
  // hasn't standardised them.
  queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export interface Workspace {
  root: FileSystemDirectoryHandle;
  name: string;
}

export class FsAccessUnsupportedError extends Error {
  constructor() {
    super('File System Access API is not available. Use a Chromium-based browser.');
  }
}

export class WorkspacePermissionDeniedError extends Error {
  constructor() {
    super('Permission to read/write the workspace directory was denied.');
  }
}

function ensureFsApi(): void {
  if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
    throw new FsAccessUnsupportedError();
  }
}

async function ensurePermission(handle: AnyDirHandle): Promise<void> {
  if (!handle.queryPermission || !handle.requestPermission) return;
  const opts = { mode: 'readwrite' as const };
  let state = await handle.queryPermission(opts);
  if (state === 'granted') return;
  state = await handle.requestPermission(opts);
  if (state !== 'granted') throw new WorkspacePermissionDeniedError();
}

export async function pickWorkspace(): Promise<Workspace> {
  ensureFsApi();
  const handle = (await (window as unknown as {
    showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker({ mode: 'readwrite', id: 'haw-datagen' })) as AnyDirHandle;
  await ensurePermission(handle);
  await idbPut(HANDLE_KEY, handle);
  return { root: handle, name: handle.name };
}

/** Restore a previously picked workspace, if one exists and permission is still granted. */
export async function restoreWorkspace(): Promise<Workspace | null> {
  if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) return null;
  const handle = await idbGet<AnyDirHandle>(HANDLE_KEY);
  if (!handle) return null;
  // Permission may need re-granting after a reload — but we DON'T prompt
  // here. The caller decides when to ask. Just check current state.
  if (handle.queryPermission) {
    const state = await handle.queryPermission({ mode: 'readwrite' });
    if (state !== 'granted') {
      return { root: handle, name: handle.name };
    }
  }
  return { root: handle, name: handle.name };
}

/** Re-prompt for permission on a previously-restored workspace. */
export async function reauthorize(workspace: Workspace): Promise<void> {
  await ensurePermission(workspace.root as AnyDirHandle);
}

export async function clearWorkspace(): Promise<void> {
  await idbDelete(HANDLE_KEY);
}

/** Get-or-create a subdirectory under the workspace root. */
export async function ensureSubdir(
  workspace: Workspace,
  ...segments: string[]
): Promise<FileSystemDirectoryHandle> {
  let dir: FileSystemDirectoryHandle = workspace.root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

/** Open a writable JSONL appender — flushes after every line. */
export async function openJsonlAppender(
  workspace: Workspace,
  relativePath: string,
): Promise<JsonlAppender> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid JSONL path: ${relativePath}`);
  const dir = await ensureSubdir(workspace, ...parts);
  const file = await dir.getFileHandle(fileName, { create: true });
  return new JsonlAppender(file);
}

export class JsonlAppender {
  private offset: number;
  private fileHandle: FileSystemFileHandle;

  constructor(fileHandle: FileSystemFileHandle) {
    this.fileHandle = fileHandle;
    this.offset = 0;
  }

  async init(): Promise<void> {
    const file = await this.fileHandle.getFile();
    this.offset = file.size;
  }

  /** Append one record as a JSON line. fsync via close() each call — slow but crash-safe. */
  async append(record: unknown): Promise<void> {
    if (this.offset === 0) await this.init();
    const writable = await this.fileHandle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(this.offset);
      const line = JSON.stringify(record) + '\n';
      await writable.write(line);
      this.offset += new TextEncoder().encode(line).byteLength;
    } finally {
      await writable.close();
    }
  }
}

/** Resolve a dataset reference (relative path) to a Blob URL the agent can LoadData from. */
export async function datasetBlobUrl(
  workspace: Workspace,
  relativePath: string,
): Promise<string> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid dataset path: ${relativePath}`);
  let dir: FileSystemDirectoryHandle = workspace.root;
  for (const seg of parts) {
    dir = await dir.getDirectoryHandle(seg, { create: false });
  }
  const handle = await dir.getFileHandle(fileName, { create: false });
  const file = await handle.getFile();
  return URL.createObjectURL(file);
}
