import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadedTable } from './duckdb';
import type { CacheMeta } from './cacheRegistry';

const { saveMock, loadMock, tablesMock } = vi.hoisted(() => ({
  saveMock: vi.fn(async (_snap: unknown) => {}),
  loadMock: vi.fn(async () => null as unknown),
  // Stand-in for duckdb.loadedTables — `data.tables` is now a projection of
  // it, so tests drive "what DuckDB has loaded" through this.
  tablesMock: { value: [] as LoadedTable[] },
}));

// executionPanelStore only pulls savePanelSnapshot / loadPanelSnapshot from
// registryPersistence; stub them so no IndexedDB is touched in node.
vi.mock('./registryPersistence', () => ({
  savePanelSnapshot: saveMock,
  loadPanelSnapshot: loadMock,
}));

// The store reads exactly one duckdb accessor (listLoadedTables) for the
// projection; stub it so tests need not boot DuckDB-wasm.
vi.mock('./duckdb', () => ({
  listLoadedTables: () => tablesMock.value,
}));

beforeEach(() => {
  saveMock.mockClear();
  loadMock.mockReset();
  loadMock.mockResolvedValue(null);
  tablesMock.value = [];
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

async function load() {
  return await import('./executionPanelStore');
}
type Store = Awaited<ReturnType<typeof load>>;

const TABLE: LoadedTable = {
  name: 'sales',
  url: 'https://example.test/sales.csv',
  format: 'csv',
  schema: [],
  rowCount: 0,
  source: 'url',
};

/**
 * Seed a loaded table the way production does: it exists in
 * duckdb.loadedTables (the mock) AND a load result settles the pane —
 * mirrors registerAndLoadBuffer -> publishTableAsInput -> setDataResult.
 */
function seedTable(s: Store, table: LoadedTable): void {
  tablesMock.value = [
    ...tablesMock.value.filter((t) => t.name !== table.name),
    table,
  ];
  s.setDataResult(table);
}

const reg = async (
  meta: CacheMeta = { name: 'q_result', source: 'sql' },
): Promise<void> => {
  const cr = await import('./cacheRegistry');
  cr.notifyCachesOnRegister(meta);
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
    seedTable(s, TABLE);
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
    seedTable(s, { ...TABLE, name: 'a' });
    seedTable(s, { ...TABLE, name: 'b' });
    s.setDataResult({ error: 'boom' });
    expect(s.getSnapshot().data.tables).toHaveLength(2);

    await cr.invalidateAcrossCaches((m) => m.name === 'a');

    const data = s.getSnapshot().data;
    expect(data.tables.map((t) => t.name)).toEqual(['b']);
    expect(data.status).toBe('error');
    expect(data.errorMessage).toBe('boom');
  });
});

describe('panelTablesCache.onRegister — settled banner self-heals on new data', () => {
  it('clears a settled error with no tables (→ idle)', async () => {
    const s = await load();
    s.setDataResult({ error: 'CORS: bad-url.csv' });
    expect(s.getSnapshot().data.status).toBe('error');

    await reg();

    expect(s.getSnapshot().data.status).toBe('idle');
    expect(s.getSnapshot().data.errorMessage).toBeUndefined();
  });

  it('clears a settled error but keeps already-loaded tables (→ done)', async () => {
    const s = await load();
    seedTable(s, TABLE);
    s.setDataResult({ error: 'boom' });
    expect(s.getSnapshot().data.status).toBe('error');

    await reg();

    expect(s.getSnapshot().data.status).toBe('done');
    expect(s.getSnapshot().data.errorMessage).toBeUndefined();
    expect(s.getSnapshot().data.tables).toHaveLength(1);
  });

  it('does not disturb an in-flight load (non-table registration mid-run)', async () => {
    const s = await load();
    s.setDataPending('sales', 'https://example.test/sales.csv');
    s.setRunning('data');
    expect(s.getSnapshot().data.status).toBe('running');

    await reg(); // q_result: not a loaded table

    expect(s.getSnapshot().data.status).toBe('running');
    expect(s.getSnapshot().data.pendingTable).toBe('sales');
  });

  it('is a no-op when the pane is already clean (no notify)', async () => {
    const s = await load();
    seedTable(s, TABLE);
    const listener = vi.fn();
    s.subscribe(listener);

    await reg();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('panelTablesCache — data.tables is a projection of duckdb.loadedTables', () => {
  it('projects a table loaded outside the LoadData lifecycle (anti-drift)', async () => {
    const s = await load();
    // Table exists in DuckDB but setDataResult was never called — the exact
    // shape of the original bug (Load button / direct loadSandboxFile).
    tablesMock.value = [TABLE];
    expect(s.getSnapshot().data.tables).toHaveLength(0);

    await reg({ name: 'sales', source: 'url' });

    const d = s.getSnapshot().data;
    expect(d.tables.map((t) => t.name)).toEqual(['sales']);
    // The "No data loaded" empty state is gated solely on tables.length.
    expect(d.tables.length).toBeGreaterThan(0);
  });

  it('does not invent a row for a registration with no matching loaded table', async () => {
    const s = await load();
    // mock stays empty — e.g. RunSQL q_result / RunPython arrow_tables.
    await reg({ name: 'q_result', source: 'sql' });

    expect(s.getSnapshot().data.tables).toHaveLength(0);
  });

  it('never deletes a table absent from duckdb (reload survival, upsert-only)', async () => {
    const s = await load();
    seedTable(s, TABLE);
    expect(s.getSnapshot().data.tables).toHaveLength(1);

    // DuckDB-wasm is empty after a reload until tables are recreated; an
    // unrelated registration must not drop the persisted projection.
    tablesMock.value = [];
    await reg({ name: 'q_result', source: 'sql' });

    expect(s.getSnapshot().data.tables.map((t) => t.name)).toEqual(['sales']);
  });

  it('projects mid-run without clobbering the live "Loading…" status', async () => {
    const s = await load();
    s.setDataPending('sales', 'https://example.test/sales.csv');
    s.setRunning('data');
    tablesMock.value = [TABLE];

    // A tabular LoadData auto-publishes to the registry mid-run.
    await reg({ name: 'sales', source: 'url' });

    const d = s.getSnapshot().data;
    expect(d.tables.map((t) => t.name)).toEqual(['sales']);
    expect(d.status).toBe('running');
    expect(d.pendingTable).toBe('sales');
  });

  it('surfaces a RunPython-produced table (source python) so it can be tagged', async () => {
    const s = await load();
    tablesMock.value = [
      {
        name: 'py_out',
        url: 'RunPython output',
        format: 'arrow',
        schema: [],
        rowCount: 3,
        source: 'python',
      },
    ];

    await reg({ name: 'py_out', source: 'python' });

    const t = s.getSnapshot().data.tables.find((x) => x.name === 'py_out');
    expect(t).toMatchObject({ source: 'python', format: 'arrow' });
  });

  it('refreshes stale schema/rowCount for an already-listed table', async () => {
    const s = await load();
    seedTable(s, TABLE); // rowCount 0, schema []

    tablesMock.value = [
      { ...TABLE, rowCount: 42, schema: [{ name: 'id', type: 'BIGINT' }] },
    ];
    await reg({ name: 'sales', source: 'url' });

    const t = s.getSnapshot().data.tables[0]!;
    expect(t.rowCount).toBe(42);
    expect(t.schema).toEqual([{ name: 'id', type: 'BIGINT' }]);
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
