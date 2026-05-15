import type * as duckdb from '@duckdb/duckdb-wasm';
import {
  Table as ArrowTable,
  tableFromIPC,
  tableToIPC,
} from 'apache-arrow';
import {
  saveRegistryEntry,
  deleteRegistryEntry,
} from './registryPersistence';
import { registerCache, type Cache } from './cacheRegistry';

export const MAX_DISPLAY_ROWS = 1000;

/** Number of sample rows surfaced to the LLM in `RunSQL` summaries. */
export const LLM_SAMPLE_ROWS = 3;

/** Per-cell character cap applied to LLM-visible string cells only. */
export const LLM_CELL_CHAR_CAP = 500;

/** Auto-published registry name that always points at the most recent RunSQL result. */
export const LAST_SQL_RESULT_NAME = '_last_sql_result';

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

/**
 * The compact summary returned to the LLM by `RunSQL`. The user-facing panel
 * receives the full `TabularResult` separately — this shape is what gets
 * serialized into the model's tool-result context, so it stays small and
 * well-bounded regardless of result size.
 */
export interface RunSQLLLMSummary {
  columns: { name: string; type: string }[];
  sample_rows: unknown[][];
  total_rows: number;
  registered_as: string;
}

export type DataFormat = 'csv' | 'json' | 'parquet';

export interface LoadedTable {
  name: string;
  url: string;
  format: DataFormat;
  schema: { name: string; type: string }[];
  rowCount: number;
  source: InputSource;
  sourcePath?: string;
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

/**
 * `name → virtualPath` index for buffers we've registered with DuckDB-WASM's
 * virtual filesystem on behalf of a tracked source (LoadData URLs, sandbox
 * files). Untracked uses (e.g. data-gen probe scratch files) bypass this.
 * `virtualFsCache` reads from this Map; pair every `db.registerFileBuffer`
 * with a write here when the registration is meant to live as long as the
 * source it represents.
 */
interface TrackedVirtualPath {
  virtualPath: string;
  source: InputSource;
  sourcePath?: string;
}
const virtualPathByName = new Map<string, TrackedVirtualPath>();

export interface RegisterInputOptions {
  encoding: InputEncoding;
  format: string;
  source: InputSource;
  sourcePath?: string;
  schema?: { name: string; type: string }[];
  rowCount?: number;
  /**
   * When true, skip the IndexedDB write-through. Used during page-reload
   * rehydration where the buffer is *already* the persisted source of truth.
   */
  skipPersist?: boolean;
}

export function registerInput(
  name: string,
  buffer: Uint8Array,
  opts: RegisterInputOptions,
): void {
  const { skipPersist, ...meta } = opts;
  const entry: RegisteredInputEntry = {
    name,
    buffer,
    byteLength: buffer.byteLength,
    publishedAt: Date.now(),
    ...meta,
  };
  inputRegistry.set(name, entry);
  if (!skipPersist) {
    const { buffer: _b, ...persistedMeta } = entry;
    void saveRegistryEntry(name, buffer, persistedMeta).catch((err) => {
      console.warn(`registryPersistence: failed to persist "${name}":`, err);
    });
  }
}

export function unregisterInput(name: string): void {
  inputRegistry.delete(name);
  void deleteRegistryEntry(name).catch((err) => {
    console.warn(`registryPersistence: failed to delete "${name}":`, err);
  });
}

/**
 * Drop every registered input + any DuckDB tables created from them, and
 * clear the IndexedDB-persisted copy. Used by "New chat" so the next
 * conversation starts with no stale data referenced.
 */
export async function clearAllInputs(): Promise<void> {
  const { invalidateAcrossCaches } = await import('./cacheRegistry');
  await invalidateAcrossCaches(() => true, { includeUnkeyedState: true });
  // Bulk-clear the persisted copy in case any cache's per-name persistence
  // path was skipped (idempotent with the per-entry deletes above).
  const { clearRegistry } = await import('./registryPersistence');
  await clearRegistry().catch((err) => {
    console.warn('clearAllInputs: IDB clear failed:', err);
  });
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

/**
 * Rehydrate the input registry from IndexedDB after a page reload. Restores
 * each persisted Arrow buffer back into both the in-memory registry (so the
 * agent's `ListInputs` and `RunPython` see them) and DuckDB (so `RunSQL`
 * queries against them succeed).
 *
 * Idempotent: if an entry is already in memory under the same name, it is
 * overwritten with the persisted version.
 */
export async function restoreRegistryFromIndexedDB(): Promise<void> {
  const { loadAllRegistryEntries } = await import('./registryPersistence');
  const entries = await loadAllRegistryEntries();
  for (const { buffer, meta } of entries) {
    registerInput(meta.name, buffer, {
      encoding: meta.encoding,
      format: meta.format,
      source: meta.source,
      sourcePath: meta.sourcePath,
      schema: meta.schema,
      rowCount: meta.rowCount,
      skipPersist: true,
    });
    if (meta.encoding === 'arrow-ipc') {
      try {
        await loadArrowIntoDuckDB(meta.name, buffer);
      } catch (err) {
        console.warn(
          `restoreRegistryFromIndexedDB: failed to load "${meta.name}" into DuckDB:`,
          err,
        );
      }
    }
  }
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

/**
 * Truncate an LLM-visible cell. Long strings get suffixed with the original
 * length so the model knows real data was elided; non-strings pass through
 * (`normalizeCell` already converts BigInts to strings before this runs).
 */
function truncateCellForLLM(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (v.length <= LLM_CELL_CHAR_CAP) return v;
  return `${v.slice(0, LLM_CELL_CHAR_CAP)}…[truncated, full=${v.length} chars]`;
}

/**
 * Build the compact summary that's returned to the LLM as a tool result.
 * Includes the result schema (with types), the first `LLM_SAMPLE_ROWS` rows
 * (with per-cell string truncation), the exact total row count, and the
 * registry name under which the full Arrow buffer was published.
 */
export function summarizeForLLM(
  table: ArrowTable,
  registeredAs: string,
): RunSQLLLMSummary {
  const columns = table.schema.fields.map((f) => ({
    name: f.name,
    type: String(f.type),
  }));
  const totalRows = table.numRows;
  const sampleCount = Math.min(LLM_SAMPLE_ROWS, totalRows);
  const vectors = columns.map((_, i) => table.getChildAt(i));
  const sample_rows: unknown[][] = new Array(sampleCount);
  for (let r = 0; r < sampleCount; r++) {
    const row = new Array(columns.length);
    for (let c = 0; c < columns.length; c++) {
      row[c] = truncateCellForLLM(normalizeCell(vectors[c]?.get(r)));
    }
    sample_rows[r] = row;
  }
  return {
    columns,
    sample_rows,
    total_rows: totalRows,
    registered_as: registeredAs,
  };
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

export function getLoadedTable(name: string): LoadedTable | undefined {
  return loadedTables.get(name);
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

  const loaded = await registerAndLoadBuffer(
    tableName,
    buffer,
    format,
    'url',
    url,
  );
  await publishTableAsInput(tableName, { format, source: 'url', sourcePath: url });
  return loaded;
}

/**
 * Register a byte buffer in DuckDB's virtual filesystem and create a table
 * over it. Shared between URL loading (loadDataFromURL) and local-file loading
 * (sandboxFiles.loadSandboxFile). `sourcePath` is the user-facing source
 * identifier (URL or sandbox-relative path) and feeds both `LoadedTable.url`
 * and the cache provenance tag.
 */
export async function registerAndLoadBuffer(
  tableName: string,
  buffer: Uint8Array,
  format: DataFormat,
  source: InputSource,
  sourcePath: string,
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
  virtualPathByName.set(tableName, { virtualPath: vpath, source, sourcePath });

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

  const loaded: LoadedTable = {
    name: tableName,
    url: sourcePath,
    format,
    schema,
    rowCount,
    source,
    sourcePath,
  };
  loadedTables.set(tableName, loaded);
  return loaded;
}

/**
 * Register a buffer in DuckDB's virtual filesystem without creating a table,
 * untracked. Use this for short-lived scratch buffers (e.g. data-gen probe
 * files inside a try/finally). Tracked sandbox/URL registrations should go
 * through `registerNamedFileBuffer` so they participate in cache invalidation.
 */
export async function registerFileBufferOnly(
  virtualPath: string,
  buffer: Uint8Array,
): Promise<void> {
  const { db } = await getDuckDB();
  await db.registerFileBuffer(virtualPath, buffer);
}

/**
 * Tracked counterpart to `registerFileBufferOnly`. Used for non-tabular
 * sandbox files (md, txt, pdf, docx, py, sql) — the buffer outlives a single
 * tool call, so it needs to participate in `virtualFsCache` invalidation when
 * the sandbox directory changes.
 */
export async function registerNamedFileBuffer(
  name: string,
  virtualPath: string,
  buffer: Uint8Array,
  source: InputSource,
  sourcePath?: string,
): Promise<void> {
  const { db } = await getDuckDB();
  await db.registerFileBuffer(virtualPath, buffer);
  virtualPathByName.set(name, { virtualPath, source, sourcePath });
}

export async function dropVirtualFile(virtualPath: string): Promise<void> {
  const { db } = await getDuckDB();
  try {
    await db.dropFile(virtualPath);
  } catch {
    // dropFile throws if the file isn't registered — best-effort.
  }
}

/**
 * Name-keyed counterpart to `dropVirtualFile` for tracked registrations
 * (anything registered via `registerNamedFileBuffer` or
 * `registerAndLoadBuffer`). Removes the index entry and drops the file.
 */
export async function untrackAndDropVirtualFile(name: string): Promise<void> {
  const info = virtualPathByName.get(name);
  if (!info) return;
  virtualPathByName.delete(name);
  await dropVirtualFile(info.virtualPath);
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

// Cache adapters — see `cacheRegistry.ts`.

const inputRegistryCache: Cache = {
  id: 'inputRegistry',
  list: () =>
    Array.from(inputRegistry.values()).map((m) => ({
      name: m.name,
      source: m.source,
      sourcePath: m.sourcePath,
    })),
  invalidateNames: async (names) => {
    for (const name of names) unregisterInput(name);
  },
};

const loadedTablesCache: Cache = {
  id: 'loadedTables',
  list: () =>
    Array.from(loadedTables.values()).map((t) => ({
      name: t.name,
      source: t.source,
      sourcePath: t.sourcePath,
    })),
  invalidateNames: async (names) => {
    for (const name of names) {
      try {
        await dropTableIfExists(name);
      } catch (err) {
        console.warn(`loadedTablesCache: failed to drop "${name}":`, err);
      }
    }
  },
};

const virtualFsCache: Cache = {
  id: 'virtualFs',
  list: () =>
    Array.from(virtualPathByName.entries()).map(([name, info]) => ({
      name,
      source: info.source,
      sourcePath: info.sourcePath,
    })),
  invalidateNames: async (names) => {
    for (const name of names) {
      const info = virtualPathByName.get(name);
      if (!info) continue;
      virtualPathByName.delete(name);
      try {
        await dropVirtualFile(info.virtualPath);
      } catch (err) {
        console.warn(`virtualFsCache: failed to drop "${name}":`, err);
      }
    }
  },
};

registerCache(inputRegistryCache);
registerCache(loadedTablesCache);
registerCache(virtualFsCache);
