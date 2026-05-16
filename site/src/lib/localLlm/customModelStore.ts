/**
 * Persistence for a user-picked custom Gemma `.task` model so it survives a
 * page reload.
 *
 * A `<input type="file">` only yields a transient `File`, so the existing
 * in-memory registry (`customModels.ts`) is lost on reload. When the browser
 * supports `window.showOpenFilePicker` we instead keep the returned
 * `FileSystemFileHandle` (structured-cloneable) in IndexedDB, reusing the
 * `haw-sandbox`/`kv` store via `sandboxStore`'s `idbGet`/`idbWrite` with
 * namespaced keys (no schema/version bump).
 *
 * File System Access permission is NOT retained across reloads, so on boot we
 * only *detect* a persisted handle (`restorable`); actually re-reading the
 * file requires one user gesture (`restoreFromHandle`, driven by the restore
 * banner).
 *
 * Contract: every model registration — both the `showOpenFilePicker` path
 * here and the `<input type="file">` fallback in `ModelSelector` — funnels
 * through `registerCustomModel` so the two picker paths cannot diverge.
 */
import { isBrowser } from '../browser';
import { idbGet, idbWrite } from '../sandboxStore';
import { registerCustomModel, type CustomLocalModel } from './customModels';

const KEY_HANDLE = 'customModel:handle';
const KEY_META = 'customModel:meta';

interface CustomModelMeta {
  id: string;
  label: string;
  fileName: string;
  chosenAt: number;
}

export type CustomModelRestoreStatus =
  | 'loading' // hydrating from IndexedDB
  | 'none' // no persisted handle
  | 'restorable' // persisted handle found, awaiting a user gesture to re-grant
  | 'restoring' // gesture received, requestPermission/getFile in flight
  | 'restored' // file re-registered into the in-memory model registry
  | 'permission-denied' // requestPermission did not return 'granted'
  | 'error' // getFile threw (file moved/deleted) or IndexedDB failure
  | 'unsupported'; // showOpenFilePicker absent — persistence path unavailable

export interface CustomModelRestoreState {
  status: CustomModelRestoreStatus;
  /** Pretty label of the persisted model, for the restore banner. */
  label?: string;
  /** The `custom:<name>` id of the persisted model. */
  modelId?: string;
}

const INITIAL_STATE: CustomModelRestoreState = { status: 'loading' };

let state: CustomModelRestoreState = INITIAL_STATE;
let currentHandle: FileSystemFileHandle | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function statesEqual(
  a: CustomModelRestoreState,
  b: CustomModelRestoreState,
): boolean {
  return (
    a.status === b.status && a.label === b.label && a.modelId === b.modelId
  );
}

function setState(next: CustomModelRestoreState): void {
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

export function getSnapshot(): CustomModelRestoreState {
  return state;
}

export function getServerSnapshot(): CustomModelRestoreState {
  return INITIAL_STATE;
}

export function isFsAccessFilePickerSupported(): boolean {
  return isBrowser() && typeof window.showOpenFilePicker === 'function';
}

type PermState = 'granted' | 'denied' | 'prompt';

/**
 * Mirror of `sandboxStore`'s private `verifyPermission` (kept local so the
 * sandbox module is untouched). Read-only access is all we need to stream the
 * `.task` file.
 */
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

export function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;

  if (!isFsAccessFilePickerSupported()) {
    setState({ status: 'unsupported' });
    return;
  }

  void (async () => {
    try {
      const [handle, meta] = await Promise.all([
        idbGet<FileSystemFileHandle>(KEY_HANDLE),
        idbGet<CustomModelMeta>(KEY_META),
      ]);
      if (!handle || !meta) {
        setState({ status: 'none' });
        return;
      }
      currentHandle = handle;

      // Non-interactive permission check — allowed on boot without a user
      // gesture. The banner exists ONLY for the case where re-reading the
      // file genuinely needs a fresh gesture. If permission is already
      // granted (OPFS handles, or a persisted grant) we re-register
      // silently and never show the banner. We deliberately do NOT trigger
      // the heavy ensureLoaded here: the saved model may not be the active
      // selection, and warming it on every boot would be wasteful. Making
      // it resolvable is enough to avoid the post-reload "unknown model"
      // error; the normal submit path loads it on demand.
      let perm: PermState;
      try {
        perm = await verifyPermission(handle, false);
      } catch {
        perm = 'prompt';
      }
      if (perm === 'granted') {
        try {
          const file = await handle.getFile();
          const model = registerCustomModel(file);
          setState({
            status: 'restored',
            label: model.label,
            modelId: model.id,
          });
        } catch (err) {
          console.error('customModelStore silent restore failed:', err);
          setState({ status: 'error', label: meta.label, modelId: meta.id });
        }
        return;
      }
      setState({ status: 'restorable', label: meta.label, modelId: meta.id });
    } catch (err) {
      console.error('customModelStore hydration failed:', err);
      setState({ status: 'none' });
    }
  })();
}

/**
 * Persist a handle obtained from `window.showOpenFilePicker`, register the
 * file into the in-memory model registry, and return the registered model.
 * The caller (ModelSelector) commits it to config + triggers `ensureLoaded`.
 */
export async function persistPickedHandle(
  handle: FileSystemFileHandle,
): Promise<CustomLocalModel> {
  const file = await handle.getFile();
  const model = registerCustomModel(file);
  const meta: CustomModelMeta = {
    id: model.id,
    label: model.label,
    fileName: file.name,
    chosenAt: Date.now(),
  };
  currentHandle = handle;
  await idbWrite((store) => {
    store.put(handle, KEY_HANDLE);
    store.put(meta, KEY_META);
  });
  setState({ status: 'restored', label: model.label, modelId: model.id });
  return model;
}

export interface RestoreResult {
  ok: boolean;
  model?: CustomLocalModel;
  reason?: 'unsupported' | 'no-handle' | 'permission-denied' | 'error';
}

/**
 * Re-grant permission for the persisted handle (interactive — must be called
 * from a user gesture), re-read the file, register it, and warm the model.
 */
export async function restoreFromHandle(): Promise<RestoreResult> {
  if (!isFsAccessFilePickerSupported()) {
    return { ok: false, reason: 'unsupported' };
  }
  const label = state.label;
  const modelId = state.modelId;

  let handle = currentHandle;
  if (!handle) {
    handle = (await idbGet<FileSystemFileHandle>(KEY_HANDLE)) ?? null;
    currentHandle = handle;
  }
  if (!handle) {
    setState({ status: 'none' });
    return { ok: false, reason: 'no-handle' };
  }

  setState({ status: 'restoring', label, modelId });

  const perm = await verifyPermission(handle, true);
  if (perm !== 'granted') {
    setState({ status: 'permission-denied', label, modelId });
    return { ok: false, reason: 'permission-denied' };
  }

  let model: CustomLocalModel;
  try {
    const file = await handle.getFile();
    model = registerCustomModel(file);
  } catch (err) {
    console.error('customModelStore restore failed:', err);
    setState({ status: 'error', label, modelId });
    return { ok: false, reason: 'error' };
  }

  setState({ status: 'restored', label: model.label, modelId: model.id });

  // Warm the model now (idempotent with the submit-path `ensureLoaded`).
  // Dynamic import keeps MediaPipe out of the boot bundle.
  void import('./llmService')
    .then(({ ensureLoaded }) => ensureLoaded(model.id))
    .catch((err) => console.error('eager restore load failed:', err));

  return { ok: true, model };
}

export async function clearPersistedCustomModel(): Promise<void> {
  currentHandle = null;
  try {
    await idbWrite((store) => {
      store.delete(KEY_HANDLE);
      store.delete(KEY_META);
    });
  } catch (err) {
    console.error('customModelStore clear failed:', err);
  }
  setState({ status: 'none' });
}
