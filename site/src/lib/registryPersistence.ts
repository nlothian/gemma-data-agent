/**
 * IndexedDB persistence for the input registry and the ExecutionPanel snapshot.
 *
 * The chat history persists across reloads via localStorage, but the data the
 * chat references (Arrow buffers in the input registry, the rendered Python /
 * SQL / Data panel) does not — so a reload leaves the conversation referring
 * to a registry that has been wiped. This module persists both, so a reload
 * can rehydrate them before the next tool call.
 *
 * Storage lives alongside the sandbox handle in the `haw-sandbox` IDB; see
 * `sandboxStore.openDb` for the version + onupgradeneeded that creates these
 * object stores.
 */
import { openDb, REGISTRY_STORE, PANEL_STORE } from './sandboxStore';
import type { RegisteredInputMeta } from './duckdb';

export interface PersistedRegistryEntry {
  buffer: Uint8Array;
  meta: RegisteredInputMeta;
}

const PANEL_KEY = 'snapshot';

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveRegistryEntry(
  name: string,
  buffer: Uint8Array,
  meta: RegisteredInputMeta,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(REGISTRY_STORE, 'readwrite');
  tx.objectStore(REGISTRY_STORE).put({ buffer, meta }, name);
  await txDone(tx);
}

export async function deleteRegistryEntry(name: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(REGISTRY_STORE, 'readwrite');
  tx.objectStore(REGISTRY_STORE).delete(name);
  await txDone(tx);
}

export async function loadAllRegistryEntries(): Promise<PersistedRegistryEntry[]> {
  const db = await openDb();
  const tx = db.transaction(REGISTRY_STORE, 'readonly');
  const req = tx.objectStore(REGISTRY_STORE).getAll();
  const result = await new Promise<PersistedRegistryEntry[]>((resolve, reject) => {
    req.onsuccess = () => resolve((req.result ?? []) as PersistedRegistryEntry[]);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  return result;
}

export async function clearRegistry(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(REGISTRY_STORE, 'readwrite');
  tx.objectStore(REGISTRY_STORE).clear();
  await txDone(tx);
}

export async function savePanelSnapshot(snap: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PANEL_STORE, 'readwrite');
  tx.objectStore(PANEL_STORE).put(snap, PANEL_KEY);
  await txDone(tx);
}

export async function loadPanelSnapshot<T = unknown>(): Promise<T | null> {
  const db = await openDb();
  const tx = db.transaction(PANEL_STORE, 'readonly');
  const req = tx.objectStore(PANEL_STORE).get(PANEL_KEY);
  const result = await new Promise<T | null>((resolve, reject) => {
    req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  await txDone(tx);
  return result;
}

export async function clearPanelSnapshot(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(PANEL_STORE, 'readwrite');
  tx.objectStore(PANEL_STORE).delete(PANEL_KEY);
  await txDone(tx);
}
