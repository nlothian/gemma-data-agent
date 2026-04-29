import type * as duckdb from '@duckdb/duckdb-wasm';
import {
  Table as ArrowTable,
  tableFromIPC,
  tableToIPC,
  type RecordBatch,
} from 'apache-arrow';

export const MAX_DISPLAY_ROWS = 1000;

export interface DuckDBHandle {
  db: duckdb.AsyncDuckDB;
  conn: duckdb.AsyncDuckDBConnection;
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

/**
 * The unified Python-input registry. Every named buffer that the agent has
 * staged for `RunPython` lives here — whether it came from `LoadData`,
 * `RunSQL(register_as=…)`, or `RunPython`'s `arrow_tables` return. The Python
 * side sees these as `arrow_inputs[name]: bytes`; the `encoding` field tells
 * the agent how to decode each one.
 */
export type InputEncoding = 'arrow-ipc' | 'raw-bytes';
export type InputSource = 'sql' | 'sandbox' | 'url' | 'python';

export interface RegisteredInputMeta {
  name: string;
  encoding: InputEncoding;
  format: string;
  source: InputSource;
  sourcePath?: string;
  schema?: { name: string; type: string }[];
  rowCount?: number;
  byteLength: number;
  publishedAt: number;
}

interface RegisteredInputEntry extends RegisteredInputMeta {
  buffer: Uint8Array;
}

const inputRegistry = new Map<string, RegisteredInputEntry>();
const loadedTables = new Map<string, LoadedTable>();

export interface RegisterInputOptions {
  encoding: InputEncoding;
  format: string;
  source: InputSource;
  sourcePath?: string;
  schema?: { name: string; type: string }[];
  rowCount?: number;
}

export function registerInput(
  name: string,
  buffer: Uint8Array,
  opts: RegisterInputOptions,
): void {
  inputRegistry.set(name, {
    name,
    buffer,
    byteLength: buffer.byteLength,
    publishedAt: Date.now(),
    ...opts,
  });
}

export function unregisterInput(name: string): void {
  inputRegistry.delete(name);
}

export function getInputBuffer(name: string): Uint8Array | undefined {
  return inputRegistry.get(name)?.buffer;
}

export function listInputs(): RegisteredInputMeta[] {
  return Array.from(inputRegistry.values()).map(
    ({ buffer: _b, ...meta }) => meta,
  );
}

export function listInputBuffers(): { name: string; buffer: Uint8Array }[] {
  return Array.from(inputRegistry.values()).map(({ name, buffer }) => ({
    name,
    buffer,
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

/**
 * Read schema + row count from an Arrow IPC stream without copying the bytes
 * into DuckDB. Used to backfill metadata when Python republishes tables.
 */
export function describeArrowIpc(buffer: Uint8Array): {
  schema: { name: string; type: string }[];
  rowCount: number;
} {
  const table = tableFromIPC(buffer);
  return {
    schema: table.schema.fields.map((f) => ({
      name: f.name,
      type: String(f.type),
    })),
    rowCount: table.numRows,
  };
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

/**
 * Run `SELECT * FROM <tableName>`, serialize the result as an Arrow IPC
 * stream, and publish it under `tableName` in the input registry so
 * `RunPython` can read `arrow_inputs[tableName]` without an extra `RunSQL`
 * round-trip. Used after `LoadData` succeeds for a tabular file.
 */
export async function publishTableAsInput(
  tableName: string,
  meta: { format: string; source: InputSource; sourcePath?: string },
): Promise<void> {
  if (!TABLE_NAME_RE.test(tableName)) return;
  const { conn } = await getDuckDB();
  const table = await conn.query(`SELECT * FROM ${quoteIdent(tableName)}`);
  const ipc = arrowTableToIPC(table);
  const schema = table.schema.fields.map((f) => ({
    name: f.name,
    type: String(f.type),
  }));
  registerInput(tableName, ipc, {
    encoding: 'arrow-ipc',
    format: meta.format,
    source: meta.source,
    sourcePath: meta.sourcePath,
    schema,
    rowCount: table.numRows,
  });
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

  const loaded = await registerAndLoadBuffer(tableName, buffer, format, url);
  await publishTableAsInput(tableName, { format, source: 'url', sourcePath: url });
  return loaded;
}

/**
 * Register a byte buffer in DuckDB's virtual filesystem and create a table
 * over it. Shared between URL loading (loadDataFromURL) and local-file loading
 * (sandboxFiles.loadSandboxFile).
 */
export async function registerAndLoadBuffer(
  tableName: string,
  buffer: Uint8Array,
  format: DataFormat,
  source: string,
  virtualPath?: string,
): Promise<LoadedTable> {
  if (!TABLE_NAME_RE.test(tableName)) {
    throw new Error(
      `Invalid table_name "${tableName}": must match [A-Za-z_][A-Za-z0-9_]*.`
    );
  }

  const { db, conn } = await getDuckDB();
  const vpath = virtualPath ?? `loaddata_${tableName}_${Date.now()}.${format}`;
  await db.registerFileBuffer(vpath, buffer);

  const ident = quoteIdent(tableName);
  const reader = readerFor(format, vpath);
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

  const loaded: LoadedTable = { name: tableName, url: source, format, schema, rowCount };
  loadedTables.set(tableName, loaded);
  return loaded;
}

/**
 * Register a buffer in DuckDB's virtual filesystem without creating a table.
 * Used for non-tabular sandbox files (md, txt, pdf, docx, py, sql) so that
 * SQL functions like read_text() / read_blob() can access them.
 */
export async function registerFileBufferOnly(
  virtualPath: string,
  buffer: Uint8Array,
): Promise<void> {
  const { db } = await getDuckDB();
  await db.registerFileBuffer(virtualPath, buffer);
}

export async function dropVirtualFile(virtualPath: string): Promise<void> {
  const { db } = await getDuckDB();
  try {
    await db.dropFile(virtualPath);
  } catch {
    // dropFile throws if the file isn't registered — best-effort.
  }
}

export async function dropTableIfExists(tableName: string): Promise<void> {
  if (!TABLE_NAME_RE.test(tableName)) return;
  const { conn } = await getDuckDB();
  await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
  loadedTables.delete(tableName);
  unregisterInput(tableName);
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
