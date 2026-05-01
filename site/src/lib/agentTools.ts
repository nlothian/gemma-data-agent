import agentSystemPromptMd from '../prompts/agentSystemPrompt.md?raw';
import { isBrowser } from './browser';
import { awaitToolGate } from './toolDebugger';
import * as panel from './executionPanelStore';
import {
  LAST_SQL_RESULT_NAME,
  type DataFormat,
  type LoadedTable,
  type RegisteredInputMeta,
  type RunSQLLLMSummary,
  type TabularResult,
} from './duckdb';

export type ToolError = {
  error: string;
};

/**
 * The LLM-facing shape of a `RunSQL` result. The execution panel receives the
 * full `TabularResult` separately (see `RunSQLPanelResult`) — this is what
 * the model sees in its tool-use loop, kept tight so a wide / long result set
 * can't blow out the chat context.
 */
export type RunSQLResult = RunSQLLLMSummary | ToolError;

/** What the execution panel store receives — full preview, unchanged from before. */
export type RunSQLPanelResult = TabularResult | ToolError;

/**
 * Internal outcome of `runSQL`: the panel preview and the LLM summary travel
 * together, so the dispatcher can route each half to its consumer.
 */
type RunSQLOutcome =
  | { panel: TabularResult; llm: RunSQLLLMSummary }
  | ToolError;

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

export type ListInputsEntry =
  | (RegisteredInputMeta & { loaded: true })
  | {
      loaded: false;
      source: 'sandbox';
      sourcePath: string;
      format: string;
      byteLength: number;
    };

export type RunListInputsResult = { inputs: ListInputsEntry[] } | ToolError;

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
 * Run a SQL query in DuckDB-WASM and produce both the panel preview and the
 * LLM-facing summary.
 *
 * Every successful call publishes the full Arrow result to the input registry
 * under `_last_sql_result`, so the next `RunPython` can always read
 * `arrow_inputs["_last_sql_result"]` without re-running the query. If
 * `registerAs` is supplied, the same buffer is *also* registered under that
 * name (which survives subsequent `RunSQL` calls that overwrite
 * `_last_sql_result`).
 */
export async function runSQL(
  sql: string,
  registerAs?: string,
): Promise<RunSQLOutcome> {
  if (!isBrowser()) return { error: BROWSER_ONLY_ERROR };
  try {
    const {
      getDuckDB,
      arrowTableToTabularResult,
      arrowTableToIPC,
      registerInput,
      summarizeForLLM,
    } = await import('./duckdb');
    const { conn } = await getDuckDB();
    const table = await conn.query(sql);
    const ipc = arrowTableToIPC(table);
    const schema = table.schema.fields.map((f) => ({
      name: f.name,
      type: String(f.type),
    }));
    const meta = {
      encoding: 'arrow-ipc' as const,
      format: 'sql-result',
      source: 'sql' as const,
      sourcePath: sql,
      schema,
      rowCount: table.numRows,
    };
    registerInput(LAST_SQL_RESULT_NAME, ipc, meta);
    if (registerAs && registerAs !== LAST_SQL_RESULT_NAME) {
      registerInput(registerAs, ipc, meta);
    }
    return {
      panel: arrowTableToTabularResult(table),
      llm: summarizeForLLM(table, LAST_SQL_RESULT_NAME),
    };
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
    const [{ loadSandboxFileByPath }, { getLoadedTable }] = await Promise.all([
      import('./sandboxFiles'),
      import('./duckdb'),
    ]);
    const loaded = await loadSandboxFileByPath(relativePath, registerAs);
    if (loaded.tableName) {
      const table = getLoadedTable(loaded.tableName);
      if (table) return table;
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
 * `arrow_inputs[name]`, plus every supported sandbox file the agent could
 * still load with `LoadData`. Read-only and ungated — this is metadata the
 * agent can fetch at any time to discover and recover state.
 */
export async function runListInputs(): Promise<RunListInputsResult> {
  if (!isBrowser()) return { error: BROWSER_ONLY_ERROR };
  try {
    const { listInputs } = await import('./duckdb');
    const registered = listInputs();
    const inputs: ListInputsEntry[] = registered.map((meta) => ({
      ...meta,
      loaded: true as const,
    }));

    const { getCurrentDirectoryHandle, getSnapshot, refreshFiles } =
      await import('./sandboxStore');
    if (getCurrentDirectoryHandle()) {
      const loadedSandboxPaths = new Set<string>();
      for (const meta of registered) {
        if (meta.source === 'sandbox' && meta.sourcePath) {
          loadedSandboxPaths.add(meta.sourcePath);
        }
      }
      await refreshFiles();
      for (const file of getSnapshot().files) {
        if (loadedSandboxPaths.has(file.relativePath)) continue;
        inputs.push({
          loaded: false,
          source: 'sandbox',
          sourcePath: file.relativePath,
          format: file.ext,
          byteLength: file.sizeBytes,
        });
      }
    }

    return { inputs };
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
    const outcome = await runWithGate<RunSQLOutcome>({
      toolName: 'RunSQL',
      gateInput: { sql, register_as: registerAs },
      signal,
      onPending: () => panel.setPending('sql', sql),
      onAborted: () => panel.setAborted('sql'),
      onRunning: () => panel.setRunning('sql'),
      onResult: (res) =>
        panel.setSqlResult('error' in res ? res : res.panel),
      run: () => runSQL(sql, registerAs),
    });
    return 'error' in outcome ? outcome : outcome.llm;
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
      'Execute a SQL query in DuckDB-WASM. On success returns ' +
      '{ columns: [{name, type}], sample_rows: unknown[][], total_rows: ' +
      'number, registered_as: string }. On failure returns { error: string }. ' +
      'You only see the first 3 rows (`sample_rows`); the FULL result of ' +
      'every successful RunSQL is auto-published to the input registry under ' +
      `\`registered_as\` (always "${LAST_SQL_RESULT_NAME}", overwritten on ` +
      'each call). To work with all rows, call RunPython and read ' +
      '`arrow_inputs[registered_as]` (decode with ' +
      '`pa.ipc.open_stream(...).read_all()`). Long string cells in ' +
      '`sample_rows` are truncated; the panel UI shows the user the full ' +
      'preview, you do not. Use SQL aggregations / LIMIT / WHERE for ' +
      'analysis you can answer in SQL; switch to RunPython for everything ' +
      'else. `register_as: "<name>"` adds an additional named handle that ' +
      `survives later RunSQL calls (which only overwrite ${LAST_SQL_RESULT_NAME}). ` +
      'Tables created by LoadData are already auto-published under their ' +
      'table name and do not need register_as.',
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
            'Optional additional name under which to publish the result as ' +
            `an Arrow IPC buffer (in addition to "${LAST_SQL_RESULT_NAME}"). ` +
            'Use this when you need the result to survive subsequent RunSQL ' +
            'calls.',
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
      'List every input the agent can work with. Returns ' +
      '{ inputs: Array<entry> } where each entry is one of two shapes ' +
      'distinguished by `loaded`. ' +
      'LOADED entries (`loaded: true`) are buffers already in the registry, ' +
      'available immediately as `arrow_inputs[name]` in RunPython: ' +
      '{ loaded: true, name, encoding, format, source, sourcePath?, ' +
      'schema?, rowCount?, byteLength, publishedAt }. `encoding` is ' +
      '"arrow-ipc" (decode with `pa.ipc.open_stream(...).read_all()`) or ' +
      '"raw-bytes" (decode with TextDecoder / pypdf / etc. per `format`); ' +
      '`source` is one of "url", "sandbox", "sql", "python". ' +
      'UNLOADED entries (`loaded: false`) are supported sandbox files the ' +
      "user's directory contains but that haven't been loaded yet: " +
      '{ loaded: false, source: "sandbox", sourcePath, format, byteLength }. ' +
      'To use one, call `LoadData(url=sourcePath, table_name=...)` — the ' +
      '`sourcePath` is the same string you would pass as a sandbox `url`. ' +
      'Read-only and ungated; safe to call any time to discover what data ' +
      'is available or recover state after a page reload.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export const AGENT_SYSTEM_PROMPT = agentSystemPromptMd.trim();
