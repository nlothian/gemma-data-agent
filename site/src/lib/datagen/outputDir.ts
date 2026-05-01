/**
 * OutputDir = a user-picked local directory used by data-gen mode for
 * generated artefacts only: tasks/, trajectories.jsonl, dpo.jsonl.
 *
 * Read-write. Distinct from the production "sandbox" directory (input
 * datasets), which the data-gen tab reads via `sandboxStore`.
 *
 * The directory handle survives across reloads via IndexedDB. On every
 * resume we check permission state but don't auto-prompt — caller decides
 * when to ask.
 */

const DB_NAME = 'haw.datagen.v1';
const STORE = 'handles';
const HANDLE_KEY = 'outputDirRoot';

type AnyDirHandle = FileSystemDirectoryHandle & {
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

export interface OutputDir {
  root: FileSystemDirectoryHandle;
  name: string;
}

export class FsAccessUnsupportedError extends Error {
  constructor() {
    super('File System Access API is not available. Use a Chromium-based browser.');
  }
}

export class OutputDirPermissionDeniedError extends Error {
  constructor() {
    super('Permission to read/write the output directory was denied.');
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
  if (state !== 'granted') throw new OutputDirPermissionDeniedError();
}

export async function pickOutputDirectory(): Promise<OutputDir> {
  ensureFsApi();
  const handle = (await (window as unknown as {
    showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker({ mode: 'readwrite', id: 'haw-datagen-output' })) as AnyDirHandle;
  await ensurePermission(handle);
  await idbPut(HANDLE_KEY, handle);
  return { root: handle, name: handle.name };
}

export async function restoreOutputDirectory(): Promise<OutputDir | null> {
  if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) return null;
  const handle = await idbGet<AnyDirHandle>(HANDLE_KEY);
  if (!handle) return null;
  return { root: handle, name: handle.name };
}

export async function reauthorize(outputDir: OutputDir): Promise<void> {
  await ensurePermission(outputDir.root as AnyDirHandle);
}

export async function clearOutputDirectory(): Promise<void> {
  await idbDelete(HANDLE_KEY);
}

/** Get-or-create a subdirectory under the output-dir root. */
export async function ensureSubdir(
  outputDir: OutputDir,
  ...segments: string[]
): Promise<FileSystemDirectoryHandle> {
  let dir: FileSystemDirectoryHandle = outputDir.root;
  for (const seg of segments) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return dir;
}

/** Open a writable JSONL appender — flushes after every line. */
export async function openJsonlAppender(
  outputDir: OutputDir,
  relativePath: string,
): Promise<JsonlAppender> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid JSONL path: ${relativePath}`);
  const dir = await ensureSubdir(outputDir, ...parts);
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

  /** Append one record as a JSON line. fsync via close() each call — crash-safe. */
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
