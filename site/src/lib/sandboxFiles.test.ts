import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadSandboxFile's non-tabular branch only touches these duckdb helpers;
// stub them so the test needs no DuckDB-wasm.
vi.mock('./duckdb', () => ({
  dropTableIfExists: vi.fn(async () => {}),
  publishTableAsInput: vi.fn(async () => {}),
  registerAndLoadBuffer: vi.fn(async () => ({})),
  registerInput: vi.fn(() => {}),
  registerNamedFileBuffer: vi.fn(async () => {}),
  unregisterInput: vi.fn(() => {}),
  untrackAndDropVirtualFile: vi.fn(async () => {}),
}));

// sandboxFiles imports these at module top; loadSandboxFile (called directly)
// never uses them, but the named bindings must resolve.
vi.mock('./sandboxStore', () => ({
  resolveFileHandle: vi.fn(),
  getCurrentDirectoryHandle: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});

async function load() {
  return await import('./sandboxFiles');
}

function fakeHandle(name: string, bytes: number): FileSystemFileHandle {
  return {
    getFile: async () => ({
      name,
      arrayBuffer: async () => new ArrayBuffer(bytes),
    }),
  } as unknown as FileSystemFileHandle;
}

describe('sandboxFilesCache — participates in the uniform cache sweep', () => {
  it('registers itself with the shared cacheRegistry on import', async () => {
    await load();
    const cr = await import('./cacheRegistry');
    expect(
      cr.listRegisteredCaches().some((c) => c.id === 'sandboxFiles'),
    ).toBe(true);
  });

  it('"Clear all" (invalidate all) drops the badge entry and notifies', async () => {
    const sb = await load();
    const cr = await import('./cacheRegistry');

    await sb.loadSandboxFile('notes.txt', fakeHandle('notes.txt', 3), 'notes');
    expect(sb.getLoadedSandboxFiles().map((e) => e.name)).toEqual(['notes']);

    const listener = vi.fn();
    sb.subscribe(listener);

    await cr.invalidateAcrossCaches(() => true, { includeUnkeyedState: true });

    expect(sb.getLoadedSandboxFiles()).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });

  it('a per-table clear (predicate by name) drops only the matching file', async () => {
    const sb = await load();
    const cr = await import('./cacheRegistry');

    await sb.loadSandboxFile('a.txt', fakeHandle('a.txt', 1), 'a');
    await sb.loadSandboxFile('b.txt', fakeHandle('b.txt', 1), 'b');
    expect(
      sb.getLoadedSandboxFiles().map((e) => e.name).sort(),
    ).toEqual(['a', 'b']);

    await cr.invalidateAcrossCaches((m) => m.name === 'a');

    expect(sb.getLoadedSandboxFiles().map((e) => e.name)).toEqual(['b']);
  });

  it('a non-matching predicate leaves the entry intact', async () => {
    const sb = await load();
    const cr = await import('./cacheRegistry');

    await sb.loadSandboxFile('keep.txt', fakeHandle('keep.txt', 1), 'keep');

    await cr.invalidateAcrossCaches((m) => m.source === 'url');

    expect(sb.getLoadedSandboxFiles().map((e) => e.name)).toEqual(['keep']);
  });
});
