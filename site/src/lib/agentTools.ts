import agentSystemPromptMd from './agentSystemPrompt.md?raw';
import { isBrowser } from './browser';
import { awaitToolGate } from './toolDebugger';
import * as panel from './executionPanelStore';
import {
  MAX_DISPLAY_ROWS,
  type DataFormat,
  type LoadedTable,
  type RegisteredInputMeta,
  type TabularResult,
} from './duckdb';

export type ToolError = {
  error: string;
};

export type RunSQLResult = TabularResult | ToolError;

export type RunPythonResult =
  | {
      result: unknown;
      stdout: string;
      stderr: string;
      images?: Uint8Array[];
    }
  | (ToolError & { stdout?: string; stderr?: string });

export interface LoadedSandboxFileResult {
  kind: 'sandbox-file';
  name: string;
  path: string;
  format: 'text' | 'binary' | 'xlsx';
  sizeBytes: number;
  virtualPath: string;
}

export type RunLoadDataResult = LoadedTable | LoadedSandboxFileResult | ToolError;

export type RunListInputsResult = { inputs: RegisteredInputMeta[] } | ToolError;

const BROWSER_ONLY_ERROR =
  'Tools can only run in the browser; this call was made in a non-browser context.';

// Warm up the heavy tool dependencies as soon as this module loads in the
// browser so they're cached before any tool call (and before the user pauses
// at the Step/Play gate). Without this, the dynamic imports inside the tool
// runners only kick off after the gate releases — and Vite may re-optimize
// deps during the pause, invalidating the URLs of in-flight imports.
const toolDepsReady: Promise<unknown> = isBrowser()
  ? Promise.all([import('./duckdb'), import('./pyodide')]).catch(() => undefined)
  : Promise.resolve();

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Run a SQL query in DuckDB-WASM and return the result set.
 *
 * If `registerAs` is provided, the result is also serialized as an Arrow IPC
 * buffer and stored in the cross-tool registry, so a subsequent `RunPython`
 * call sees it as `arrow_inputs["<registerAs>"]: bytes`.
 */
export async function runSQL(
  sql: string,
  registerAs?: string
): Promise<RunSQLResult> {
  if (!isBrowser()) return { error: BROWSER_ONLY_ERROR };
  try {
    const {
      getDuckDB,
      arrowTableToTabularResult,
      arrowTableToIPC,
      registerInput,
      runStreamingSql,
    } = await import('./duckdb');
    if (registerAs) {
      const { conn } = await getDuckDB();
      const table = await conn.query(sql);
      const ipc = arrowTableToIPC(table);
      registerInput(registerAs, ipc, {
        encoding: 'arrow-ipc',
        format: 'sql-result',
        source: 'sql',
        sourcePath: sql,
        schema: table.schema.fields.map((f) => ({
          name: f.name,
          type: String(f.type),
        })),
        rowCount: table.numRows,
      });
      return arrowTableToTabularResult(table);
    }
    return await runStreamingSql(sql);
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * Load a remote CSV / JSON / Parquet file into DuckDB. The fetch happens on
 * the main thread so CORS errors surface with browser-canonical messages.
 */
export async function runLoadData(
  url: string,
  tableName: string,
  format?: DataFormat,
): Promise<RunLoadDataResult> {
  if (!isBrowser()) return { error: BROWSER_ONLY_ERROR };
  try {
    const { loadDataFromURL } = await import('./duckdb');
    return await loadDataFromURL(tableName, url, format);
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * Load a file from the user's chosen sandbox directory. Tabular formats
 * (csv/json/parquet/xlsx) become DuckDB tables; non-tabular formats
 * (md/txt/py/sql/pdf/docx) are registered as bytes accessible from RunPython
 * via `arrow_inputs[name]`.
 */
export async function runLoadDataLocal(
  relativePath: string,
  registerAs: string,
): Promise<RunLoadDataResult> {
  if (!isBrowser()) return { error: BROWSER_ONLY_ERROR };
  try {
    const { loadSandboxFileByPath } = await import('./sandboxFiles');
    const loaded = await loadSandboxFileByPath(relativePath, registerAs);
    if (loaded.tableName && loaded.schema && loaded.rowCount !== undefined) {
      const tableFormat: DataFormat = loaded.format === 'json' ? 'json' : 'csv';
      return {
        name: loaded.tableName,
        url: relativePath,
        format: tableFormat,
        schema: loaded.schema,
        rowCount: loaded.rowCount,
      } satisfies LoadedTable;
    }
    return {
      kind: 'sandbox-file',
      name: loaded.name,
      path: loaded.relativePath,
      format: loaded.format as 'text' | 'binary' | 'xlsx',
      sizeBytes: loaded.sizeBytes,
      virtualPath: loaded.virtualPath,
    };
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'NotFoundError') {
      return { error: `File not found in sandbox: ${relativePath}` };
    }
    if (name === 'NotAllowedError') {
      return {
        error: 'Permission lost — re-authorise the sandbox in Settings → Sandbox.',
      };
    }
    return { error: errorMessage(err) };
  }
}

/**
 * Execute a Python snippet in Pyodide. Arrow tables previously published via
 * `RunSQL(register_as=...)` are exposed as `arrow_inputs: dict[str, bytes]`.
 * Assigning `arrow_tables = {name: ipc_bytes, ...}` registers each entry into
 * DuckDB so a later `RunSQL` can `SELECT * FROM <name>`.
 */
export async function runPython(code: string): Promise<RunPythonResult> {
  if (!isBrowser()) return { error: BROWSER_ONLY_ERROR };
  try {
    const [{ runPython: runInPyodide }, duck] = await Promise.all([
      import('./pyodide'),
      import('./duckdb'),
    ]);
    const { listInputBuffers, registerInput, loadArrowIntoDuckDB, describeArrowIpc } = duck;

    const inputs = listInputBuffers();

    const res = await runInPyodide(code, inputs);

    if (res.ok) {
      if (res.arrowTables && res.arrowTables.length > 0) {
        for (const { name, buffer } of res.arrowTables) {
          let schema: { name: string; type: string }[] | undefined;
          let rowCount: number | undefined;
          try {
            ({ schema, rowCount } = describeArrowIpc(buffer));
          } catch {
            // Malformed IPC — register without schema; loadArrowIntoDuckDB
            // will surface a more useful error if the buffer is bad.
          }
          registerInput(name, buffer, {
            encoding: 'arrow-ipc',
            format: 'python-result',
            source: 'python',
            schema,
            rowCount,
          });
          await loadArrowIntoDuckDB(name, buffer);
        }
      }
      return {
        result: res.result ?? '',
        stdout: res.stdout,
        stderr: res.stderr,
        images: res.images,
      };
    }
    return {
      error: res.error ?? 'Python execution failed.',
      stdout: res.stdout,
      stderr: res.stderr,
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * List every named buffer currently available to RunPython as
 * `arrow_inputs[name]`. Read-only and ungated — this is metadata the agent
 * can fetch at any time to recover from "what tables / files do I have?".
 */
export async function runListInputs(): Promise<RunListInputsResult> {
  if (!isBrowser()) return { error: BROWSER_ONLY_ERROR };
  try {
    const { listInputs } = await import('./duckdb');
    return { inputs: listInputs() };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * Provider-neutral tool definition. `parameters` is a JSON Schema describing
 * the tool's input arguments. Translated per-provider in `streamChat`.
 */
export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GateOptions<TResult> {
  toolName: string;
  gateInput: unknown;
  signal: AbortSignal | undefined;
  onPending: () => void;
  onAborted: () => void;
  onRunning: () => void;
  onResult: (res: TResult) => void;
  run: () => Promise<TResult>;
}

/**
 * Shared lifecycle for every gated tool: warm deps, mark pending, suspend on
 * the Step/Play/Pause gate (with abort handling), then run and publish the
 * result to the panel.
 */
async function runWithGate<TResult>(opts: GateOptions<TResult>): Promise<TResult> {
  await toolDepsReady;
  opts.onPending();
  try {
    await awaitToolGate(opts.toolName, opts.gateInput, opts.signal);
  } catch (err) {
    opts.onAborted();
    throw err;
  }
  opts.onRunning();
  const res = await opts.run();
  opts.onResult(res);
  return res;
}

/**
 * Dispatch a tool call by name. Used by `streamChat`'s tool-use loop.
 */
export async function runAgentTool(
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (name === 'RunSQL') {
    const sql = typeof obj.sql === 'string' ? obj.sql : '';
    const registerAs = typeof obj.register_as === 'string' ? obj.register_as : undefined;
    return runWithGate<RunSQLResult>({
      toolName: 'RunSQL',
      gateInput: { sql, register_as: registerAs },
      signal,
      onPending: () => panel.setPending('sql', sql),
      onAborted: () => panel.setAborted('sql'),
      onRunning: () => panel.setRunning('sql'),
      onResult: panel.setSqlResult,
      run: () => runSQL(sql, registerAs),
    });
  }
  if (name === 'RunPython') {
    const code = typeof obj.code === 'string' ? obj.code : '';
    const res = await runWithGate<RunPythonResult>({
      toolName: 'RunPython',
      gateInput: { code },
      signal,
      onPending: () => panel.setPending('python', code),
      onAborted: () => panel.setAborted('python'),
      onRunning: () => panel.setRunning('python'),
      onResult: panel.setPythonResult,
      run: () => runPython(code),
    });
    // Strip image bytes from the wire return — the panel store already
    // converted them to ObjectURLs and the LLM only sees text.
    if ('images' in res && res.images) {
      const { images: _images, ...rest } = res;
      return rest;
    }
    return res;
  }
  if (name === 'ListInputs') {
    return runListInputs();
  }
  if (name === 'LoadData') {
    const url = typeof obj.url === 'string' ? obj.url : '';
    const tableName = typeof obj.table_name === 'string' ? obj.table_name : '';
    const fmt = typeof obj.format === 'string' ? obj.format : undefined;
    const format =
      fmt === 'csv' || fmt === 'json' || fmt === 'parquet' ? fmt : undefined;
    const isRemote = /:\/\//.test(url);
    return runWithGate<RunLoadDataResult>({
      toolName: 'LoadData',
      gateInput: { url, table_name: tableName, format },
      signal,
      onPending: () => panel.setDataPending(tableName, url),
      onAborted: () => panel.setAborted('data'),
      onRunning: () => panel.setRunning('data'),
      onResult: panel.setDataResult,
      run: () =>
        isRemote
          ? runLoadData(url, tableName, format)
          : runLoadDataLocal(url, tableName),
    });
  }
  return { error: `Unknown tool: ${name}` } satisfies ToolError;
}

export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: 'LoadData',
    description:
      'Load a data file by URL or by a path inside the user\'s sandbox ' +
      'directory. If `url` contains "://" it is treated as a remote URL; ' +
      'otherwise it is a relative path inside the sandbox directory the ' +
      'user picked in Settings (e.g. "reports/sales.csv"). For tabular ' +
      'formats (csv, json, parquet, xlsx) a DuckDB table named `table_name` ' +
      'is created AND the table is auto-published to the Python input ' +
      'registry as Arrow IPC under the same `table_name`, so RunPython can ' +
      'immediately read `arrow_inputs[table_name]` with ' +
      '`pa.ipc.open_stream(...).read_all()` (no extra RunSQL needed). For ' +
      'non-tabular sandbox files (md, txt, py, sql, pdf, docx) the raw bytes ' +
      'are registered under `table_name` and read in RunPython as ' +
      '`arrow_inputs[table_name]: bytes`. Use ListInputs to inspect the ' +
      'registry; the entry\'s `encoding` field tells you how to decode. ' +
      'Remote URLs require CORS (Access-Control-Allow-Origin); on CORS ' +
      'failure surface the error verbatim and do not retry. Prefer this over ' +
      'fetching files inside RunPython.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Public URL of a remote data file, or a path relative to the ' +
            'user\'s sandbox directory (e.g. "reports/sales.csv"). Strings ' +
            'containing "://" are URLs.',
        },
        table_name: {
          type: 'string',
          description:
            'DuckDB table name for tabular files; arrow_inputs key for ' +
            'non-tabular files. Must match [A-Za-z_][A-Za-z0-9_]*.',
        },
        format: {
          type: 'string',
          enum: ['csv', 'json', 'parquet', 'xlsx'],
          description:
            'Optional format override for tabular loads; inferred from the ' +
            'extension otherwise.',
        },
      },
      required: ['url', 'table_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'RunSQL',
    description:
      'Execute a SQL query in DuckDB-WASM and return the result set. On ' +
      'success returns { columns: string[], rows: unknown[][], truncated: ' +
      'boolean }. On failure returns { error: string }. The `rows` array is ' +
      `capped at the first ${MAX_DISPLAY_ROWS} rows for preview; ` +
      '`truncated: true` means more rows exist — add a LIMIT/aggregation or ' +
      'use `register_as` to route the full result to RunPython. ' +
      'When `register_as` is set, the full result is published to the input ' +
      'registry as Arrow IPC and shows up as `arrow_inputs["<register_as>"]` ' +
      'in subsequent RunPython calls (decode with ' +
      '`pa.ipc.open_stream(...).read_all()`). Use this for derived results; ' +
      'tables created by LoadData are auto-published under their table name ' +
      'and do not need register_as.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute.',
        },
        register_as: {
          type: 'string',
          description:
            'Optional name under which to publish the result as an Arrow IPC ' +
            'buffer for later RunPython calls.',
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'RunPython',
    description:
      'Execute a snippet of Python in Pyodide. Returns { result, stdout, ' +
      'stderr } where `result` is the str() of the last expression. On ' +
      'failure returns { error, stdout, stderr }. ' +
      'IMPORTANT: Pyodide runs in a separate Worker and CANNOT connect to ' +
      'DuckDB — `pandas.read_sql_query`, `duckdb.connect`, SQLAlchemy etc. ' +
      'will fail. The only bridge is `arrow_inputs[name]: bytes`, populated ' +
      'by LoadData (auto), RunSQL(register_as=...), and prior RunPython ' +
      '`arrow_tables` returns. Call ListInputs to see what\'s available and ' +
      'each entry\'s `encoding` (\"arrow-ipc\" → use ' +
      '`pa.ipc.open_stream(arrow_inputs[name]).read_all()`; \"raw-bytes\" → ' +
      'use TextDecoder / pypdf / etc. on the bytes). Assigning ' +
      '`arrow_tables = {"name": ipc_bytes, ...}` loads each entry into ' +
      'DuckDB and republishes it.',
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The Python source to execute.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'ListInputs',
    description:
      'List every named buffer currently available to RunPython as ' +
      '`arrow_inputs[name]`. Returns { inputs: Array<{ name, encoding, ' +
      'format, source, sourcePath?, schema?, rowCount?, byteLength, ' +
      'publishedAt }> }. `encoding` is "arrow-ipc" (decode with ' +
      '`pa.ipc.open_stream(...).read_all()`) or "raw-bytes" (decode with ' +
      'TextDecoder / pypdf / etc. per `format`). `source` is one of "url", ' +
      '"sandbox", "sql", "python". Read-only and ungated; safe to call any ' +
      'time the agent needs to recover the registry state (e.g. after a ' +
      'page reload).',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export const AGENT_SYSTEM_PROMPT = agentSystemPromptMd.trim();
