import { beforeEach, describe, expect, it, vi } from 'vitest';

// recordPythonTable only mutates the loadedTables map + broadcasts via
// cacheRegistry — no DuckDB-wasm (getDuckDB) is reached, so this runs in
// node. duckdb.ts is import-safe here (apache-arrow is the only top-level
// value import; wasm inits lazily in getDuckDB).
beforeEach(() => {
  vi.resetModules();
});

describe('recordPythonTable — RunPython output surfaces in loadedTables', () => {
  it('records the table tagged python/arrow and broadcasts a register', async () => {
    const duck = await import('./duckdb');
    const cr = await import('./cacheRegistry');

    const onRegister = vi.fn();
    cr.registerCache({
      id: 'probe',
      list: () => [],
      invalidateNames: async () => {},
      onRegister,
    });

    const schema = [
      { name: 'g', type: 'VARCHAR' },
      { name: 'n', type: 'BIGINT' },
    ];
    duck.recordPythonTable('py_out', schema, 7);

    expect(duck.listLoadedTables().find((x) => x.name === 'py_out')).toEqual({
      name: 'py_out',
      url: 'RunPython output',
      format: 'arrow',
      schema,
      rowCount: 7,
      source: 'python',
    });
    expect(onRegister).toHaveBeenCalledWith({
      name: 'py_out',
      source: 'python',
    });
  });

  it('overwrites a prior entry of the same name (re-publish)', async () => {
    const duck = await import('./duckdb');

    duck.recordPythonTable('t', [], 1);
    duck.recordPythonTable('t', [{ name: 'a', type: 'INTEGER' }], 9);

    const rows = duck.listLoadedTables().filter((x) => x.name === 't');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowCount: 9,
      schema: [{ name: 'a', type: 'INTEGER' }],
    });
  });
});
