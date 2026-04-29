/**
 * Sandbox file registry — tracks every file loaded from the chosen local
 * directory. Both tabular (CSV / JSON / Parquet / XLSX) and non-tabular
 * (MD / TXT / PY / SQL / PDF / DOCX) files are recorded here. Tabular files
 * additionally get a DuckDB table; non-tabular files just get their bytes
 * registered in DuckDB's virtual FS and exposed to RunPython via
 * `arrow_inputs[name]`.
 */
import {
  dropTableIfExists,
  dropVirtualFile,
  publishTableAsInput,
  registerAndLoadBuffer,
  registerFileBufferOnly,
  registerInput,
  unregisterInput,
  type DataFormat,
  type LoadedTable,
} from './duckdb';
import {
  resolveFileHandle,
  getCurrentDirectoryHandle,
  type SupportedExt,
} from './sandboxStore';

export type SandboxFileFormat =
  | 'csv'
  | 'json'
  | 'parquet'
  | 'xlsx'
  | 'text'
  | 'binary';

export interface LoadedSandboxFile {
  relativePath: string;
  name: string;            // registry key (== tableName for tabular)
  format: SandboxFileFormat;
  sizeBytes: number;
  loadedAt: number;
  virtualPath: string;
  tableName?: string;
  schema?: { name: string; type: string }[];
  rowCount?: number;
}

const EXT_FORMAT: Record<SupportedExt, SandboxFileFormat> = {
  csv: 'csv',
  json: 'json',
  xls: 'xlsx',
  xlsx: 'xlsx',
  md: 'text',
  txt: 'text',
  py: 'text',
  sql: 'text',
  pdf: 'binary',
  docx: 'binary',
};

const TABULAR_FORMATS: ReadonlySet<SandboxFileFormat> = new Set([
  'csv',
  'json',
  'parquet',
  'xlsx',
]);

const registry = new Map<string, LoadedSandboxFile>();
let snapshot: LoadedSandboxFile[] | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = null;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLoadedSandboxFiles(): LoadedSandboxFile[] {
  return (snapshot ??= Array.from(registry.values()));
}

export function getSandboxFile(
  relativePath: string,
): LoadedSandboxFile | undefined {
  return registry.get(relativePath);
}

function extOf(name: string): SupportedExt {
  const dot = name.lastIndexOf('.');
  return name.slice(dot + 1).toLowerCase() as SupportedExt;
}

function virtualPathFor(relativePath: string): string {
  return `sandbox/${relativePath}`;
}

async function disposeEntry(entry: LoadedSandboxFile): Promise<void> {
  unregisterInput(entry.name);
  await dropVirtualFile(entry.virtualPath);
  if (entry.tableName) {
    try {
      await dropTableIfExists(entry.tableName);
    } catch {
      // best-effort
    }
  }
}

/**
 * Load a sandbox file. For tabular formats, `registerAs` becomes the DuckDB
 * table name (must match `[A-Za-z_][A-Za-z0-9_]*`). For non-tabular formats,
 * `registerAs` becomes the `arrow_inputs[name]` key in RunPython.
 */
export async function loadSandboxFile(
  relativePath: string,
  fileHandle: FileSystemFileHandle,
  registerAs: string,
): Promise<LoadedSandboxFile> {
  const existing = registry.get(relativePath);
  if (existing) await disposeEntry(existing);

  const file = await fileHandle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = extOf(file.name);
  const format = EXT_FORMAT[ext];
  if (!format) throw new Error(`Unsupported sandbox file extension: ${ext}`);
  const virtualPath = virtualPathFor(relativePath);
  const loadedAt = Date.now();
  let entry: LoadedSandboxFile;

  if (TABULAR_FORMATS.has(format)) {
    const { tableBytes, duckFormat } = await coerceToDuckFormat(bytes, format);
    const loaded: LoadedTable = await registerAndLoadBuffer(
      registerAs,
      tableBytes,
      duckFormat,
      relativePath,
      virtualPath,
    );
    await publishTableAsInput(registerAs, {
      format,
      source: 'sandbox',
      sourcePath: relativePath,
    });
    entry = {
      relativePath,
      name: registerAs,
      format,
      sizeBytes: bytes.byteLength,
      loadedAt,
      virtualPath,
      tableName: loaded.name,
      schema: loaded.schema,
      rowCount: loaded.rowCount,
    };
  } else {
    await registerFileBufferOnly(virtualPath, bytes);
    registerInput(registerAs, bytes, {
      encoding: 'raw-bytes',
      format: ext,
      source: 'sandbox',
      sourcePath: relativePath,
    });
    entry = {
      relativePath,
      name: registerAs,
      format,
      sizeBytes: bytes.byteLength,
      loadedAt,
      virtualPath,
    };
  }

  registry.set(relativePath, entry);
  notify();
  return entry;
}

/**
 * Resolve a sandbox-relative path and load it. Single entry point used by the
 * agent's `LoadData` tool for the local-file branch.
 */
export async function loadSandboxFileByPath(
  relativePath: string,
  registerAs: string,
): Promise<LoadedSandboxFile> {
  if (!getCurrentDirectoryHandle()) {
    throw new Error(
      'No sandbox directory selected. Open Settings → Sandbox to choose one.',
    );
  }
  const fileHandle = await resolveFileHandle(relativePath);
  return loadSandboxFile(relativePath, fileHandle, registerAs);
}

async function coerceToDuckFormat(
  bytes: Uint8Array,
  format: SandboxFileFormat,
): Promise<{ tableBytes: Uint8Array; duckFormat: DataFormat }> {
  if (format === 'csv') return { tableBytes: bytes, duckFormat: 'csv' };
  if (format === 'json') return { tableBytes: bytes, duckFormat: 'json' };
  if (format === 'parquet') return { tableBytes: bytes, duckFormat: 'parquet' };
  if (format === 'xlsx') {
    return { tableBytes: await xlsxToCsvBytes(bytes), duckFormat: 'csv' };
  }
  throw new Error(`Not a tabular format: ${format}`);
}

async function xlsxToCsvBytes(bytes: Uint8Array): Promise<Uint8Array> {
  // TODO: multi-sheet support — currently only the first sheet is exported.
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(bytes, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('Excel workbook has no sheets.');
  }
  const sheet = workbook.Sheets[firstSheetName];
  if (!sheet) {
    throw new Error(`Excel sheet "${firstSheetName}" is empty.`);
  }
  return new TextEncoder().encode(XLSX.utils.sheet_to_csv(sheet));
}

export async function clearAllSandboxFiles(): Promise<void> {
  if (registry.size === 0) return;
  const entries = Array.from(registry.values());
  registry.clear();
  await Promise.all(entries.map(disposeEntry));
  notify();
}
