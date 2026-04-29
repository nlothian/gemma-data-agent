import type * as duckdb from '@duckdb/duckdb-wasm';
import { Table as ArrowTable, tableToIPC, type RecordBatch } from 'apache-arrow';

export const MAX_DISPLAY_ROWS = 1000;

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
  /** True when the underlying result had more rows than were materialized. */
  truncated: boolean;
}

export type DataFormat = 'csv' | 'json' | 'parquet';

export interface LoadedTable {
  name: string;
  url: string;
  format: DataFormat;
  schema: { name: string; type: string }[];
  rowCount: number;
}

const arrowTableRegistry = new Map<string, Uint8Array>();
const loadedTables = new Map<string, LoadedTable>();

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
  const totalRows = table.numRows;
  const limit = Math.min(MAX_DISPLAY_ROWS, totalRows);
  const vectors = columns.map((_, i) => table.getChildAt(i));
  const rows: unknown[][] = new Array(limit);
  for (let r = 0; r < limit; r++) {
    const row = new Array(columns.length);
    for (let c = 0; c < columns.length; c++) {
      row[c] = normalizeCell(vectors[c]?.get(r));
    }
    rows[r] = row;
  }
  return { columns, rows, truncated: totalRows > limit };
}

export async function runStreamingSql(sql: string): Promise<TabularResult> {
  const { conn } = await getDuckDB();
  const reader = await conn.send(sql);
  const batches: RecordBatch[] = [];
  let collected = 0;
  let truncated = false;
  try {
    for await (const batch of reader) {
      batches.push(batch);
      collected += batch.numRows;
      if (collected > MAX_DISPLAY_ROWS) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        // reader may already be closed; cancel is best-effort
      }
    }
  }
  if (batches.length === 0) {
    return { columns: [], rows: [], truncated: false };
  }
  return arrowTableToTabularResult(new ArrowTable(batches));
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

export function listLoadedTables(): LoadedTable[] {
  return Array.from(loadedTables.values());
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function inferFormat(url: string): DataFormat | undefined {
  const path = url.split('?')[0]!.toLowerCase();
  if (path.endsWith('.csv') || path.endsWith('.csv.gz') || path.endsWith('.tsv')) return 'csv';
  if (path.endsWith('.parquet') || path.endsWith('.pq')) return 'parquet';
  if (
    path.endsWith('.json') ||
    path.endsWith('.ndjson') ||
    path.endsWith('.jsonl') ||
    path.endsWith('.json.gz')
  )
    return 'json';
  return undefined;
}

function readerFor(format: DataFormat, virtualPath: string): string {
  const lit = "'" + virtualPath.replace(/'/g, "''") + "'";
  if (format === 'csv') return `read_csv_auto(${lit})`;
  if (format === 'json') return `read_json_auto(${lit})`;
  return `read_parquet(${lit})`;
}

export async function loadDataFromURL(
  tableName: string,
  url: string,
  formatHint?: DataFormat
): Promise<LoadedTable> {
  if (!TABLE_NAME_RE.test(tableName)) {
    throw new Error(
      `Invalid table_name "${tableName}": must match [A-Za-z_][A-Za-z0-9_]*.`
    );
  }
  const format = formatHint ?? inferFormat(url);
  if (!format) {
    throw new Error(
      `Could not infer format from URL "${url}". Pass format: "csv" | "json" | "parquet" explicitly.`
    );
  }

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch (err) {
    // Browser fetch throws TypeError on CORS / network failures with no
    // distinguishing flag. Surface a CORS-aware message.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not fetch ${url}: ${detail}. This is usually because the ` +
        `server did not return an 'Access-Control-Allow-Origin' header. ` +
        `Try a CORS-enabled host (e.g. raw.githubusercontent.com, an S3 ` +
        `bucket with CORS configured, or https://shell.duckdb.org/data/...) ` +
        `or proxy the file.`
    );
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} fetching ${url}`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());

  const { db, conn } = await getDuckDB();
  const virtualPath = `loaddata_${tableName}_${Date.now()}.${format}`;
  await db.registerFileBuffer(virtualPath, buffer);

  const ident = quoteIdent(tableName);
  const reader = readerFor(format, virtualPath);
  await conn.query(`CREATE OR REPLACE TABLE ${ident} AS SELECT * FROM ${reader}`);

  const [describeTable, countTable] = await Promise.all([
    conn.query(`DESCRIBE ${ident}`),
    conn.query(`SELECT count(*) AS n FROM ${ident}`),
  ]);
  const describeRows = arrowTableToTabularResult(describeTable);
  const nameIdx = describeRows.columns.indexOf('column_name');
  const typeIdx = describeRows.columns.indexOf('column_type');
  const schema = describeRows.rows.map((row) => ({
    name: String(row[nameIdx] ?? ''),
    type: String(row[typeIdx] ?? ''),
  }));

  const countRow = countTable.toArray()[0];
  const rowCountRaw = countRow?.toJSON?.()?.n ?? 0;
  const rowCount =
    typeof rowCountRaw === 'bigint' ? Number(rowCountRaw) : Number(rowCountRaw);

  const loaded: LoadedTable = { name: tableName, url, format, schema, rowCount };
  loadedTables.set(tableName, loaded);
  return loaded;
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
