import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadedTable } from './duckdb';

const { saveMock, loadMock } = vi.hoisted(() => ({
  saveMock: vi.fn(async (_snap: unknown) => {}),
  loadMock: vi.fn(async () => null as unknown),
}));

// executionPanelStore only pulls savePanelSnapshot / loadPanelSnapshot from
// registryPersistence; stub them so no IndexedDB is touched in node.
vi.mock('./registryPersistence', () => ({
  savePanelSnapshot: saveMock,
  loadPanelSnapshot: loadMock,
}));

beforeEach(() => {
  saveMock.mockClear();
  loadMock.mockReset();
  loadMock.mockResolvedValue(null);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function load() {
  return await import('./executionPanelStore');
}

const TABLE: LoadedTable = {
  name: 'sales',
  url: 'https://example.test/sales.csv',
  format: 'csv',
  schema: [],
  rowCount: 0,
  source: 'url',
};

describe('clearDataError — single Data-pane reconciler', () => {
  it('error with no tables → idle, error cleared', async () => {
    const s = await load();
    s.setDataResult({ error: 'Cannot resolve sandbox path "input/x.csv"' });
    expect(s.getSnapshot().data.status).toBe('error');

    s.clearDataError();

    expect(s.getSnapshot().data.status).toBe('idle');
    expect(s.getSnapshot().data.errorMessage).toBeUndefined();
  });

  it('error with tables → done, tables preserved', async () => {
    const s = await load();
    s.setDataResult(TABLE);
    s.setDataResult({ error: 'boom' });
    expect(s.getSnapshot().data.status).toBe('error');
    expect(s.getSnapshot().data.tables).toHaveLength(1);

    s.clearDataError();

    expect(s.getSnapshot().data.status).toBe('done');
    expect(s.getSnapshot().data.errorMessage).toBeUndefined();
    expect(s.getSnapshot().data.tables).toHaveLength(1);
  });

  it('also clears a stuck pending load', async () => {
    const s = await load();
    s.setDataPending('missing', 'sandbox:missing.csv');
    expect(s.getSnapshot().data.status).toBe('pending');

    s.clearDataError();

    expect(s.getSnapshot().data.status).toBe('idle');
    expect(s.getSnapshot().data.pendingUrl).toBeUndefined();
    expect(s.getSnapshot().data.pendingTable).toBeUndefined();
  });

  it('is a no-op on an already-clean pane (no notify)', async () => {
    const s = await load();
    const listener = vi.fn();
    s.subscribe(listener);

    s.clearDataError();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('panelTablesCache.onSweep — wired into invalidateAcrossCaches', () => {
  it('clears a Data-pane error when a sweep runs (no tables)', async () => {
    // load() runs executionPanelStore's module-level
    // registerCache(panelTablesCache); assert it landed in the same
    // cacheRegistry instance this test drives, so the wiring is exercised
    // for real rather than assumed.
    const s = await load();
    const cr = await import('./cacheRegistry');
    expect(cr.listRegisteredCaches().some((c) => c.id === 'panelTables')).toBe(
      true,
    );
    s.setDataResult({ error: 'boom' });
    expect(s.getSnapshot().data.status).toBe('error');

    await cr.invalidateAcrossCaches(() => true, { includeUnkeyedState: true });

    expect(s.getSnapshot().data.status).toBe('idle');
    expect(s.getSnapshot().data.errorMessage).toBeUndefined();
  });

  it('removes the matching table without clearing a coexisting error', async () => {
    const s = await load();
    const cr = await import('./cacheRegistry');
    s.setDataResult({ ...TABLE, name: 'a' });
    s.setDataResult({ ...TABLE, name: 'b' });
    s.setDataResult({ error: 'boom' });
    expect(s.getSnapshot().data.tables).toHaveLength(2);

    await cr.invalidateAcrossCaches((m) => m.name === 'a');

    const data = s.getSnapshot().data;
    expect(data.tables.map((t) => t.name)).toEqual(['b']);
    expect(data.status).toBe('error');
    expect(data.errorMessage).toBe('boom');
  });
});

describe('buildPersisted — transient error is never written', () => {
  it('demotes a persisted error status and drops errorMessage', async () => {
    vi.useFakeTimers();
    const s = await load();
    s.setDataResult({ error: 'stuck' });
    expect(s.getSnapshot().data.status).toBe('error');

    // schedulePersist debounces by PERSIST_DEBOUNCE_MS (500ms).
    vi.advanceTimersByTime(500);

    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'idle',
          errorMessage: undefined,
        }),
      }),
    );
  });
});

describe('restorePanelFromIndexedDB — legacy stuck error is unstuck', () => {
  const legacy = (data: unknown) => ({
    activeTab: 'data',
    python: { status: 'idle' },
    sql: { status: 'idle' },
    data,
    file: {},
  });

  it('clears a persisted error with no tables (→ idle)', async () => {
    loadMock.mockResolvedValue(
      legacy({ status: 'error', errorMessage: 'stuck', tables: [] }),
    );
    const s = await load();

    await s.restorePanelFromIndexedDB();

    expect(s.getSnapshot().data.status).toBe('idle');
    expect(s.getSnapshot().data.errorMessage).toBeUndefined();
  });

  it('clears a persisted error but keeps tables (→ done)', async () => {
    loadMock.mockResolvedValue(
      legacy({ status: 'error', errorMessage: 'stuck', tables: [TABLE] }),
    );
    const s = await load();

    await s.restorePanelFromIndexedDB();

    expect(s.getSnapshot().data.status).toBe('done');
    expect(s.getSnapshot().data.errorMessage).toBeUndefined();
    expect(s.getSnapshot().data.tables).toHaveLength(1);
  });
});
