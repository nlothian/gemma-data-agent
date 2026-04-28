import type * as duckdb from '@duckdb/duckdb-wasm';
import { tableToIPC, type Table as ArrowTable } from 'apache-arrow';

export interface DuckDBHandle {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
}

export interface RegisteredArrowTable {
  name: string;
  byteLength: number;
}

export interface TabularResult {
  columns: string[];
  rows: unknown[][];
}

const arrowTableRegistry = new Map<string, Uint8Array>();

export function registerArrowTable(name: string, buffer: Uint8Array): void {
  arrowTableRegistry.set(name, buffer);
}

export function getArrowTable(name: string): Uint8Array | undefined {
  return arrowTableRegistry.get(name);
}

export function listArrowTables(): RegisteredArrowTable[] {
  return Array.from(arrowTableRegistry, ([name, buf]) => ({
    name,
    byteLength: buf.byteLength,
  }));
}

let instancePromise: Promise<DuckDBHandle> | null = null;

export function getDuckDB(): Promise<DuckDBHandle> {
  if (!instancePromise) {
    instancePromise = (async () => {
      const duckdbMod = await import('@duckdb/duckdb-wasm');
      const bundles = duckdbMod.getJsDelivrBundles();
      const bundle = await duckdbMod.selectBundle(bundles);

      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker!}");`], {
          type: 'text/javascript',
        })
      );

      const worker = new Worker(workerUrl);
      const logger = new duckdbMod.ConsoleLogger();
      const db = new duckdbMod.AsyncDuckDB(logger, worker);
      await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);

      const conn = await db.connect();
      return { db, conn };
    })();
  }
  return instancePromise;
}

export function arrowTableToTabularResult(table: ArrowTable): TabularResult {
  const columns = table.schema.fields.map((f) => f.name);
  const rows = table.toArray().map((row) => {
    const obj = row.toJSON();
    return columns.map((c) => normalizeCell(obj[c]));
  });
  return { columns, rows };
}

function normalizeCell(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  return v;
}

export async function loadArrowIntoDuckDB(
  name: string,
  buffer: Uint8Array
): Promise<void> {
  const { conn } = await getDuckDB();
  await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
  await conn.insertArrowFromIPCStream(buffer.slice(), {
    name,
    create: true,
  });
}

export function arrowTableToIPC(table: ArrowTable): Uint8Array {
  return tableToIPC(table, 'stream');
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
