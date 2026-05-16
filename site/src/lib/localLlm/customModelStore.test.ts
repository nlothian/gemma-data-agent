import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared, reload-stable in-memory IndexedDB and an ensureLoaded spy. `vi.hoisted`
// keeps these alive across `vi.resetModules()` so we can simulate a page reload.
const h = vi.hoisted(() => ({
  mem: new Map<string, unknown>(),
  ensureLoaded: vi.fn(),
}));

vi.mock('../sandboxStore', () => ({
  idbGet: async (k: string) => h.mem.get(k),
  idbWrite: async (
    ops: (s: {
      put: (v: unknown, k: string) => void;
      delete: (k: string) => void;
    }) => void,
  ) => {
    ops({
      put: (v, k) => h.mem.set(k, v),
      delete: (k) => h.mem.delete(k),
    });
  },
}));

vi.mock('./llmService', () => ({ ensureLoaded: h.ensureLoaded }));

// Must match the private constants in customModelStore.ts.
const KEY_HANDLE = 'customModel:handle';
const KEY_META = 'customModel:meta';
const META = {
  id: 'custom:My-Model',
  label: 'My Model',
  fileName: 'My-Model.task',
  chosenAt: 1,
};

type Perm = 'granted' | 'denied' | 'prompt';
function fakeHandle(
  opts: {
    queryPerm?: Perm;
    requestPerm?: Perm;
    getFile?: () => Promise<File>;
  } = {},
) {
  return {
    queryPermission: vi.fn(async () => opts.queryPerm ?? 'prompt'),
    requestPermission: vi.fn(
      async () => opts.requestPerm ?? opts.queryPerm ?? 'prompt',
    ),
    getFile:
      opts.getFile ??
      vi.fn(async () => new File([new Uint8Array([1])], 'My-Model.task')),
  };
}

async function freshStore() {
  vi.resetModules();
  return await import('./customModelStore');
}

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timeout waiting for ${label}`);
}

beforeEach(() => {
  h.mem.clear();
  h.ensureLoaded.mockReset().mockResolvedValue(undefined);
  (globalThis as { window?: unknown }).window = {
    showOpenFilePicker: () => {},
  };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe('customModelStore', () => {
  it('hydrates to "none" when nothing is persisted', async () => {
    const store = await freshStore();
    store.hydrateOnce();
    await waitFor(() => store.getSnapshot().status === 'none', 'none');
  });

  it('hydrates to "unsupported" when showOpenFilePicker is unavailable', async () => {
    (globalThis as { window?: unknown }).window = {};
    const store = await freshStore();
    store.hydrateOnce();
    expect(store.getSnapshot().status).toBe('unsupported');
  });

  it('shows the banner ("restorable") only when permission must be re-granted', async () => {
    const handle = fakeHandle({ queryPerm: 'prompt' });
    h.mem.set(KEY_HANDLE, handle);
    h.mem.set(KEY_META, META);
    const store = await freshStore();
    store.hydrateOnce();
    await waitFor(
      () => store.getSnapshot().status === 'restorable',
      'restorable',
    );
    expect(store.getSnapshot()).toMatchObject({
      status: 'restorable',
      label: 'My Model',
      modelId: 'custom:My-Model',
    });
    // Boot must not prompt — only the non-interactive query may run.
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('silently re-registers WITHOUT a banner when permission is already granted', async () => {
    const handle = fakeHandle({ queryPerm: 'granted' });
    h.mem.set(KEY_HANDLE, handle);
    h.mem.set(KEY_META, META);
    const store = await freshStore();
    const cm = await import('./customModels');
    store.hydrateOnce();
    await waitFor(
      () => store.getSnapshot().status === 'restored',
      'restored (silent)',
    );
    // Never shows the banner, never prompts, and makes the model resolvable…
    expect(handle.requestPermission).not.toHaveBeenCalled();
    expect(cm.getCustomModel('custom:My-Model')).toBeDefined();
    // …but does NOT eagerly warm a possibly-unselected model on boot.
    expect(h.ensureLoaded).not.toHaveBeenCalled();
  });

  it('persistPickedHandle registers the model, writes IDB, and sets "restored"', async () => {
    const store = await freshStore();
    const handle = fakeHandle();
    const model = await store.persistPickedHandle(
      handle as unknown as FileSystemFileHandle,
    );
    expect(model.id).toBe('custom:My-Model');
    expect(h.mem.get(KEY_HANDLE)).toBe(handle);
    expect(h.mem.get(KEY_META)).toMatchObject({ id: 'custom:My-Model' });
    expect(store.getSnapshot().status).toBe('restored');
  });

  it('survives a simulated reload: persist then re-hydrate to "restorable"', async () => {
    const first = await freshStore();
    await first.persistPickedHandle(
      fakeHandle({ queryPerm: 'prompt' }) as unknown as FileSystemFileHandle,
    );
    // Reload: fresh module instance, same persisted IDB. The picked handle
    // needs a gesture on the next load, so the banner is offered.
    const second = await freshStore();
    second.hydrateOnce();
    await waitFor(
      () => second.getSnapshot().status === 'restorable',
      'restorable after reload',
    );
    expect(second.getSnapshot().modelId).toBe('custom:My-Model');
  });

  it('restoreFromHandle (granted) registers the model and warms it', async () => {
    h.mem.set(
      KEY_HANDLE,
      fakeHandle({ queryPerm: 'prompt', requestPerm: 'granted' }),
    );
    h.mem.set(KEY_META, META);
    const store = await freshStore();
    store.hydrateOnce();
    await waitFor(
      () => store.getSnapshot().status === 'restorable',
      'restorable',
    );
    const res = await store.restoreFromHandle();
    expect(res.ok).toBe(true);
    expect(store.getSnapshot().status).toBe('restored');
    await waitFor(
      () => h.ensureLoaded.mock.calls.length > 0,
      'ensureLoaded called',
    );
    expect(h.ensureLoaded).toHaveBeenCalledWith('custom:My-Model');
  });

  it('restoreFromHandle (denied) → "permission-denied"', async () => {
    h.mem.set(
      KEY_HANDLE,
      fakeHandle({ queryPerm: 'prompt', requestPerm: 'denied' }),
    );
    h.mem.set(KEY_META, META);
    const store = await freshStore();
    store.hydrateOnce();
    await waitFor(
      () => store.getSnapshot().status === 'restorable',
      'restorable',
    );
    const res = await store.restoreFromHandle();
    expect(res).toEqual({ ok: false, reason: 'permission-denied' });
    expect(store.getSnapshot().status).toBe('permission-denied');
    expect(h.ensureLoaded).not.toHaveBeenCalled();
  });

  it('restoreFromHandle (file gone) → "error"', async () => {
    h.mem.set(
      KEY_HANDLE,
      fakeHandle({
        queryPerm: 'prompt',
        requestPerm: 'granted',
        getFile: vi.fn(async () => {
          throw new Error('NotFoundError');
        }),
      }),
    );
    h.mem.set(KEY_META, META);
    const store = await freshStore();
    store.hydrateOnce();
    await waitFor(
      () => store.getSnapshot().status === 'restorable',
      'restorable',
    );
    const res = await store.restoreFromHandle();
    expect(res.reason).toBe('error');
    expect(store.getSnapshot().status).toBe('error');
  });

  it('clearPersistedCustomModel deletes the keys and resets to "none"', async () => {
    const store = await freshStore();
    await store.persistPickedHandle(
      fakeHandle() as unknown as FileSystemFileHandle,
    );
    await store.clearPersistedCustomModel();
    expect(h.mem.has(KEY_HANDLE)).toBe(false);
    expect(h.mem.has(KEY_META)).toBe(false);
    expect(store.getSnapshot().status).toBe('none');
  });
});
