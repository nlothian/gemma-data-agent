/**
 * Sandbox directory state — IndexedDB-backed.
 *
 * Holds a FileSystemDirectoryHandle the user picked via `showDirectoryPicker`,
 * plus the recursively-walked list of supported files inside it. The handle
 * cannot be JSON-serialized, so localStorage is unsuitable; everything lives
 * in IndexedDB.
 */
import { isBrowser } from './browser';

export const SUPPORTED_EXTS = [
  'csv',
  'xls',
  'xlsx',
  'json',
  'pdf',
  'md',
  'txt',
  'docx',
  'py',
  'sql',
] as const;

export type SupportedExt = (typeof SUPPORTED_EXTS)[number];

const SUPPORTED_EXT_SET: ReadonlySet<string> = new Set(SUPPORTED_EXTS);

export type SandboxStatus =
  | 'loading'
  | 'unset'
  | 'permitted'
  | 'permission-denied'
  | 'unsupported';

export interface SandboxFileEntry {
  relativePath: string;
  name: string;
  ext: SupportedExt;
  sizeBytes: number;
  fileHandle: FileSystemFileHandle;
}

export interface SandboxState {
  status: SandboxStatus;
  directoryName?: string;
  files: SandboxFileEntry[];
}

const DB_NAME = 'haw-sandbox';
const DB_VERSION = 1;
const STORE = 'kv';
const KEY_HANDLE = 'directoryHandle';
const KEY_META = 'meta';

interface SandboxMeta {
  name: string;
  chosenAt: number;
}

const INITIAL_STATE: SandboxState = { status: 'loading', files: [] };

let state: SandboxState = INITIAL_STATE;
let currentHandle: FileSystemDirectoryHandle | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function statesEqual(a: SandboxState, b: SandboxState): boolean {
  if (a.status !== b.status || a.directoryName !== b.directoryName) return false;
  if (a.files === b.files) return true;
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i]!;
    const y = b.files[i]!;
    if (
      x.relativePath !== y.relativePath ||
      x.sizeBytes !== y.sizeBytes ||
      x.fileHandle !== y.fileHandle
    ) {
      return false;
    }
  }
  return true;
}

function setState(next: SandboxState): void {
  if (statesEqual(state, next)) return;
  state = next;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): SandboxState {
  return state;
}

export function getServerSnapshot(): SandboxState {
  return INITIAL_STATE;
}

export function getCurrentDirectoryHandle(): FileSystemDirectoryHandle | null {
  return currentHandle;
}

function hasFsAccess(): boolean {
  return isBrowser() && typeof window.showDirectoryPicker === 'function';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbWrite(
  ops: (store: IDBObjectStore) => void,
): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    ops(tx.objectStore(STORE));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

type PermState = 'granted' | 'denied' | 'prompt';

async function verifyPermission(
  handle: FileSystemHandle,
  interactive: boolean,
): Promise<PermState> {
  const opts = { mode: 'read' as const };
  const queried = await handle.queryPermission(opts);
  if (queried === 'granted') return 'granted';
  if (!interactive) return queried;
  return await handle.requestPermission(opts);
}

export function extOf(name: string): SupportedExt | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return SUPPORTED_EXT_SET.has(ext) ? (ext as SupportedExt) : undefined;
}

async function* walkDirectory(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): AsyncGenerator<SandboxFileEntry> {
  for await (const entry of dir.values()) {
    const childPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      yield* walkDirectory(entry, childPath);
      continue;
    }
    const ext = extOf(entry.name);
    if (!ext) continue;
    let sizeBytes = 0;
    try {
      const file = await entry.getFile();
      sizeBytes = file.size;
    } catch (err) {
      // Permission may have been revoked between the walk starting and this
      // file being read; surface the entry with size 0 so the user can see
      // it but at least knows we couldn't stat it.
      console.warn(`sandbox: could not stat ${childPath}:`, err);
    }
    yield {
      relativePath: childPath,
      name: entry.name,
      ext,
      sizeBytes,
      fileHandle: entry,
    };
  }
}

async function enumerateFiles(
  dir: FileSystemDirectoryHandle,
): Promise<SandboxFileEntry[]> {
  const out: SandboxFileEntry[] = [];
  for await (const f of walkDirectory(dir)) out.push(f);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

async function applyPermissionAndEnumerate(
  handle: FileSystemDirectoryHandle,
  directoryName: string,
  interactive: boolean,
): Promise<void> {
  const perm = await verifyPermission(handle, interactive);
  if (perm !== 'granted') {
    setState({ status: 'permission-denied', directoryName, files: [] });
    return;
  }
  setState({
    status: 'permitted',
    directoryName,
    files: await enumerateFiles(handle),
  });
}

export function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;

  if (!hasFsAccess()) {
    setState({ status: 'unsupported', files: [] });
    return;
  }

  void (async () => {
    try {
      const [handle, meta] = await Promise.all([
        idbGet<FileSystemDirectoryHandle>(KEY_HANDLE),
        idbGet<SandboxMeta>(KEY_META),
      ]);
      if (!handle) {
        setState({ status: 'unset', files: [] });
        return;
      }
      currentHandle = handle;
      await applyPermissionAndEnumerate(
        handle,
        meta?.name ?? handle.name,
        false,
      );
    } catch (err) {
      console.error('sandboxStore hydration failed:', err);
      setState({ status: 'unset', files: [] });
    }
  })();
}

export async function chooseDirectory(): Promise<void> {
  if (!hasFsAccess()) return;
  const handle = await window.showDirectoryPicker({ mode: 'read' });
  // showDirectoryPicker already prompted; permission is granted.
  currentHandle = handle;
  const meta: SandboxMeta = { name: handle.name, chosenAt: Date.now() };
  await idbWrite((store) => {
    store.put(handle, KEY_HANDLE);
    store.put(meta, KEY_META);
  });
  try {
    const { clearAllSandboxFiles } = await import('./sandboxFiles');
    await clearAllSandboxFiles();
  } catch {
    // sandboxFiles may not have been imported yet — nothing to clear.
  }
  setState({
    status: 'permitted',
    directoryName: handle.name,
    files: await enumerateFiles(handle),
  });
}

export async function reAuthorise(): Promise<void> {
  if (!currentHandle) return;
  await applyPermissionAndEnumerate(
    currentHandle,
    state.directoryName ?? currentHandle.name,
    true,
  );
}

export async function refreshFiles(): Promise<void> {
  if (!currentHandle) return;
  await applyPermissionAndEnumerate(
    currentHandle,
    state.directoryName ?? currentHandle.name,
    false,
  );
}

export async function clearDirectory(): Promise<void> {
  currentHandle = null;
  await idbWrite((store) => {
    store.delete(KEY_HANDLE);
    store.delete(KEY_META);
  });
  try {
    const { clearAllSandboxFiles } = await import('./sandboxFiles');
    await clearAllSandboxFiles();
  } catch {
    // ignore
  }
  setState({ status: 'unset', files: [] });
}

export async function resolveFileHandle(
  relativePath: string,
): Promise<FileSystemFileHandle> {
  if (!currentHandle) {
    throw new Error('No sandbox directory selected.');
  }
  const segments = relativePath.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(`Empty sandbox path.`);
  }
  let dir: FileSystemDirectoryHandle = currentHandle;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i]!);
  }
  return await dir.getFileHandle(segments[segments.length - 1]!);
}
