/**
 * Probe a workspace-local dataset to produce a human-readable schema
 * summary (column names, types, row count, sample rows). Uses DuckDB-WASM
 * directly via `registerFileBufferOnly` so the probe does NOT pollute the
 * input registry — important because the data-gen UI shouldn't add stuff
 * to the agent's tool-visible registry just because the user clicked a
 * file in the picker.
 */
import {
  arrowTableToTabularResult,
  getDuckDB,
  registerFileBufferOnly,
  dropVirtualFile,
} from '../duckdb';
import { type Workspace } from './workspace';

export interface SchemaColumn {
  name: string;
  type: string;
}

export interface DatasetProbe {
  path: string;
  format: 'csv' | 'tsv' | 'parquet' | 'json' | 'jsonl';
  rowCount: number;
  columns: SchemaColumn[];
  sampleRows: unknown[][];
  /** A pre-formatted summary suitable to drop into the task-generator prompt. */
  formattedSummary: string;
}

export class UnsupportedFormatError extends Error {}

function readerFor(ext: string, virtualPath: string): string {
  const lit = `'${virtualPath.replace(/'/g, "''")}'`;
  switch (ext) {
    case 'csv':
      return `read_csv_auto(${lit})`;
    case 'tsv':
      return `read_csv_auto(${lit}, delim='\\t')`;
    case 'parquet':
      return `read_parquet(${lit})`;
    case 'json':
    case 'jsonl':
      return `read_json_auto(${lit})`;
    default:
      throw new UnsupportedFormatError(
        `Probe doesn't support .${ext} (only csv/tsv/parquet/json/jsonl).`,
      );
  }
}

function formatSummary(probe: Omit<DatasetProbe, 'formattedSummary'>): string {
  const cols = probe.columns
    .map((c) => `  ${c.name} (${c.type})`)
    .join('\n');
  const sampleLines = probe.sampleRows.map((row) =>
    '  ' + row.map((v) => formatValue(v)).join(' | '),
  );
  return [
    `File: ${probe.path}`,
    `Format: ${probe.format}`,
    `Rows: ${probe.rowCount.toLocaleString()}`,
    ``,
    `Columns:`,
    cols,
    ``,
    `Sample rows (${probe.sampleRows.length}):`,
    `  ${probe.columns.map((c) => c.name).join(' | ')}`,
    ...sampleLines,
  ].join('\n');
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'string') return v.length > 30 ? `"${v.slice(0, 27)}…"` : `"${v}"`;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
  return String(v);
}

async function fileFor(
  workspace: Workspace,
  relativePath: string,
): Promise<File> {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) throw new Error(`Invalid path: ${relativePath}`);
  let dir: FileSystemDirectoryHandle = workspace.root;
  for (const seg of parts) {
    dir = await dir.getDirectoryHandle(seg, { create: false });
  }
  const handle = await dir.getFileHandle(fileName, { create: false });
  return handle.getFile();
}

export async function probeDataset(
  workspace: Workspace,
  relativePath: string,
  sampleN = 5,
): Promise<DatasetProbe> {
  const dot = relativePath.lastIndexOf('.');
  const ext = dot < 0 ? '' : relativePath.slice(dot + 1).toLowerCase();
  if (!['csv', 'tsv', 'parquet', 'json', 'jsonl'].includes(ext)) {
    throw new UnsupportedFormatError(
      `Probe doesn't support .${ext} (only csv/tsv/parquet/json/jsonl).`,
    );
  }
  const format = ext as DatasetProbe['format'];

  const file = await fileFor(workspace, relativePath);
  const buffer = new Uint8Array(await file.arrayBuffer());
  const virtualPath = `__datagen_probe__/${Date.now()}.${ext}`;
  await registerFileBufferOnly(virtualPath, buffer);

  try {
    const { conn } = await getDuckDB();
    const reader = readerFor(ext, virtualPath);

    const [describeTable, countTable, sampleTable] = await Promise.all([
      conn.query(`DESCRIBE SELECT * FROM ${reader}`),
      conn.query(`SELECT count(*) AS n FROM ${reader}`),
      conn.query(`SELECT * FROM ${reader} LIMIT ${sampleN}`),
    ]);

    const describe = arrowTableToTabularResult(describeTable);
    const nameIdx = describe.columns.indexOf('column_name');
    const typeIdx = describe.columns.indexOf('column_type');
    const columns: SchemaColumn[] = describe.rows.map((row) => ({
      name: String(row[nameIdx] ?? ''),
      type: String(row[typeIdx] ?? ''),
    }));

    const countArr = countTable.toArray()[0];
    const countRaw = countArr?.toJSON?.()?.n ?? 0;
    const rowCount =
      typeof countRaw === 'bigint' ? Number(countRaw) : Number(countRaw);

    const sample = arrowTableToTabularResult(sampleTable);
    const sampleRows = sample.rows;

    const partial = { path: relativePath, format, rowCount, columns, sampleRows };
    return { ...partial, formattedSummary: formatSummary(partial) };
  } finally {
    await dropVirtualFile(virtualPath);
  }
}
