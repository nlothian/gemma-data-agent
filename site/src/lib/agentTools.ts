import baseMd from '../prompts/agent/base.md?raw';
import dataLoadingMd from '../prompts/agent/dataLoading.md?raw';
import runSqlMd from '../prompts/agent/runSql.md?raw';
import runPythonMd from '../prompts/agent/runPython.md?raw';
import runReactMd from '../prompts/agent/runReact.md?raw';
import runSubAgentMd from '../prompts/agent/runSubAgent.md?raw';
import fileToolsMd from '../prompts/agent/fileTools.md?raw';
import { isBrowser } from './browser';
import { awaitToolGate } from './toolDebugger';
import * as panel from './executionPanelStore';
import {
  listFilesUnder,
  readLinesFromFile,
  readTextFileAt,
  writeLinesToFile,
} from './agentFs';
import {
  LAST_SQL_RESULT_NAME,
  type DataFormat,
  type LoadedTable,
  type RegisteredInputMeta,
  type RunSQLLLMSummary,
  type TabularResult,
} from './duckdb';
import type { RunReactResult } from './reactSandbox';

// ─── Public types ─────────────────────────────────────────────────────────

export type ToolError = { error: string; path?: string };

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

/**
 * Provider-neutral tool definition. `parameters` is a JSON Schema describing
 * the tool's input arguments. Translated per-provider in `streamChat`.
 */
export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentPromptFeatures {
  dataLoading?: boolean;
  runSql?: boolean;
  runPython?: boolean;
  runReact?: boolean;
  runSubAgent?: boolean;
  fileTools?: boolean;
}

export const DEFAULT_FEATURES: AgentPromptFeatures = {
  dataLoading: true,
  runSql: true,
  runPython: true,
  runReact: true,
  runSubAgent: true,
  fileTools: true,
};

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

// ─── Tool function bodies ─────────────────────────────────────────────────

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
 * Compile + render a TypeScript + React snippet inside the sandbox iframe
 * managed by `reactSandbox.ts`. Surfaces compile diagnostics and runtime
 * errors for the agent's self-correction loop.
 */
export async function runReact(code: string): Promise<RunReactResult> {
  if (!isBrowser()) {
    return {
      ok: false,
      compileErrors: [],
      runtimeErrors: [{ message: BROWSER_ONLY_ERROR }],
    };
  }
  const { runReactSandbox } = await import('./reactSandbox');
  return runReactSandbox(code);
}

// ─── Path-based execution wrappers ────────────────────────────────────────
//
// On error the wrappers re-emit `path` so the agent can ReadLines/WriteLines
// the file without remembering it. The manual ExecutionPanel re-run also
// goes through these (after writing the editor buffer to /scratchpad/manual/*).

async function loadForRun(
  kind: 'python' | 'sql' | 'react',
  path: string,
): Promise<{ source: string } | { errorMessage: string }> {
  if (!isBrowser()) return { errorMessage: BROWSER_ONLY_ERROR };
  let source: string;
  try {
    source = await readTextFileAt(path);
  } catch (err) {
    return { errorMessage: errorMessage(err) };
  }
  panel.setStreamingSource(kind, source);
  return { source };
}

export async function runSQLAtPath(
  path: string,
  registerAs?: string,
): Promise<RunSQLOutcome> {
  const loaded = await loadForRun('sql', path);
  if ('errorMessage' in loaded) return { error: loaded.errorMessage, path };
  const res = await runSQL(loaded.source, registerAs);
  if ('error' in res) return { ...res, path };
  return res;
}

export async function runPythonAtPath(
  path: string,
): Promise<RunPythonResult & { path?: string }> {
  const loaded = await loadForRun('python', path);
  if ('errorMessage' in loaded) {
    return { error: loaded.errorMessage, path, stdout: '', stderr: '' };
  }
  const res = await runPython(loaded.source);
  return { ...res, path };
}

export async function runReactAtPath(
  path: string,
): Promise<RunReactResult & { path?: string }> {
  const loaded = await loadForRun('react', path);
  if ('errorMessage' in loaded) {
    return {
      ok: false,
      compileErrors: [],
      runtimeErrors: [{ message: loaded.errorMessage }],
      path,
    };
  }
  const res = await runReact(loaded.source);
  return { ...res, path };
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
    const [{ listInputs }, { getCurrentDirectoryHandle, getSnapshot, refreshFiles }] =
      await Promise.all([import('./duckdb'), import('./sandboxStore')]);
    const registered = listInputs();
    const inputs: ListInputsEntry[] = registered.map((meta) => ({
      ...meta,
      loaded: true as const,
    }));

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

// ─── Gate lifecycle helper ────────────────────────────────────────────────

interface GateOptions<TResult> {
  toolName: string;
  gateInput: unknown;
  signal: AbortSignal | undefined;
  onPending?: () => void;
  onAborted?: () => void;
  onRunning?: () => void;
  onResult?: (res: TResult) => void;
  run: () => Promise<TResult>;
}

/**
 * Shared lifecycle for every gated tool: warm deps, mark pending, suspend on
 * the Step/Play/Pause gate (with abort handling), then run and publish the
 * result to the panel.
 */
async function runWithGate<TResult>(opts: GateOptions<TResult>): Promise<TResult> {
  await toolDepsReady;
  opts.onPending?.();
  try {
    await awaitToolGate(opts.toolName, opts.gateInput, opts.signal);
  } catch (err) {
    opts.onAborted?.();
    throw err;
  }
  opts.onRunning?.();
  const res = await opts.run();
  opts.onResult?.(res);
  return res;
}

// ─── Tool registry ────────────────────────────────────────────────────────

interface AgentTool<TInput, TResult, TWire = TResult> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Markdown fragment appended to the system prompt when this tool is enabled. */
  promptMd: string | null;
  /** Feature-flag key controlling availability. `null` = always available. */
  featureKey: keyof AgentPromptFeatures | null;
  /** If `false`, dispatch skips `runWithGate` entirely. Defaults to true. */
  gated?: boolean;
  parseInput: (raw: Record<string, unknown>) => TInput;
  /** What the Step/Play gate UI sees. Defaults to the parsed input. */
  gateInput?: (input: TInput) => unknown;
  run: (input: TInput, signal: AbortSignal | undefined) => Promise<TResult>;
  panel?: {
    onPending: (input: TInput) => void;
    onRunning: (input: TInput) => void;
    onAborted: (input: TInput) => void;
    onResult: (res: TResult, input: TInput) => void;
  };
  /** Optional projection from internal result to the LLM-facing wire shape. */
  toWire?: (res: TResult, input: TInput) => TWire;
}

interface LoadDataInput {
  url: string;
  tableName: string;
  format: 'csv' | 'json' | 'parquet' | undefined;
  isRemote: boolean;
}

interface RunSQLInput {
  path: string;
  registerAs: string | undefined;
}

interface RunPythonInput {
  path: string;
}

interface RunReactInput {
  path: string;
}

interface ListFilesInput {
  path: string;
}

interface ReadLinesInput {
  path: string;
  from: number;
  to: number;
}

interface WriteLinesInput {
  path: string;
  from: number;
  to: number;
  content: string;
}

interface RunSubAgentInput {
  prompt: string;
  taskLabel: string | undefined;
}

const LoadDataTool: AgentTool<LoadDataInput, RunLoadDataResult> = {
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
          'containing "://" are URLs. For sandbox files, pass the ' +
          '`sourcePath` from ListInputs verbatim — do NOT add a URI ' +
          'scheme like "sandbox:" or "file://", and do NOT prepend a ' +
          'leading "/". Adding any of those produces a "Name is not ' +
          'allowed" error from the browser file API.',
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
  promptMd: dataLoadingMd,
  featureKey: 'dataLoading',
  parseInput: (raw) => {
    // The agent occasionally invents a `sandbox:` (or `file:`) URI scheme for
    // local paths even though the docs ask for a bare relative path. Strip
    // those prefixes so the lookup works instead of failing the FS Access
    // name validator with "Name is not allowed".
    const rawUrl = typeof raw.url === 'string' ? raw.url : '';
    const url = rawUrl.replace(/^(?:sandbox:|file:\/\/)/, '');
    const tableName = typeof raw.table_name === 'string' ? raw.table_name : '';
    const fmt = typeof raw.format === 'string' ? raw.format : undefined;
    const format =
      fmt === 'csv' || fmt === 'json' || fmt === 'parquet' ? fmt : undefined;
    const isRemote = /:\/\//.test(url);
    return { url, tableName, format, isRemote };
  },
  gateInput: (input) => ({
    url: input.url,
    table_name: input.tableName,
    format: input.format,
  }),
  run: (input) =>
    input.isRemote
      ? runLoadData(input.url, input.tableName, input.format)
      : runLoadDataLocal(input.url, input.tableName),
  panel: {
    onPending: (input) => panel.setDataPending(input.tableName, input.url),
    onRunning: () => panel.setRunning('data'),
    onAborted: () => panel.setAborted('data'),
    onResult: panel.setDataResult,
  },
};

const RunSQLTool: AgentTool<RunSQLInput, RunSQLOutcome, RunSQLResult> = {
  name: 'RunSQL',
  description:
    'Execute a SQL query in DuckDB-WASM. The query is loaded from a `.sql` ' +
    'file at `path` under /scratchpad or /input — write it with WriteLines ' +
    'first. On success returns { columns: [{name, type}], sample_rows: ' +
    'unknown[][], total_rows: number, registered_as: string, path: string }. ' +
    'On failure returns { error: string, path: string }. ' +
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
      path: {
        type: 'string',
        description:
          'Path to a .sql file under /scratchpad or /input. Use WriteLines ' +
          'to write the query first, then pass the same path here.',
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
    required: ['path'],
    additionalProperties: false,
  },
  promptMd: runSqlMd,
  featureKey: 'runSql',
  parseInput: (raw) => ({
    path: typeof raw.path === 'string' ? raw.path : '',
    registerAs: typeof raw.register_as === 'string' ? raw.register_as : undefined,
  }),
  gateInput: (input) => ({ path: input.path, register_as: input.registerAs }),
  run: (input) => runSQLAtPath(input.path, input.registerAs),
  panel: {
    onPending: (input) => panel.setPending('sql', '', input.path),
    onRunning: () => panel.setRunning('sql'),
    onAborted: () => panel.setAborted('sql'),
    onResult: (res) => panel.setSqlResult('error' in res ? res : res.panel),
  },
  toWire: (res) => ('error' in res ? res : res.llm),
};

const RunPythonTool: AgentTool<
  RunPythonInput,
  RunPythonResult & { path?: string }
> = {
  name: 'RunPython',
  description:
    'Execute Python in Pyodide. The code is loaded from a `.py` file at ' +
    '`path` under /scratchpad or /input — write it with WriteLines first. ' +
    'Returns { result, stdout, stderr, path } where `result` is the str() ' +
    'of the last expression. On failure returns { error, stdout, stderr, ' +
    'path } so you can ReadLines the file, fix it with WriteLines, and ' +
    're-run. ' +
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
      path: {
        type: 'string',
        description:
          'Path to a .py file under /scratchpad or /input. Use WriteLines ' +
          'to write the code first, then pass the same path here.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  promptMd: runPythonMd,
  featureKey: 'runPython',
  parseInput: (raw) => ({ path: typeof raw.path === 'string' ? raw.path : '' }),
  run: (input) => runPythonAtPath(input.path),
  panel: {
    onPending: (input) => panel.setPending('python', '', input.path),
    onRunning: () => panel.setRunning('python'),
    onAborted: () => panel.setAborted('python'),
    onResult: panel.setPythonResult,
  },
  // Strip image bytes from the wire return — the panel store already
  // converted them to ObjectURLs and the LLM only sees text. Preserve
  // `path` so error self-correction is possible.
  toWire: (res) => {
    if ('images' in res && res.images) {
      const { images: _images, ...rest } = res;
      return rest;
    }
    return res;
  },
};

const RunReactTool: AgentTool<RunReactInput, RunReactResult & { path?: string }> = {
  name: 'RunReact',
  description:
    'Render an interactive React component. The TypeScript + JSX source ' +
    'is loaded from a `.tsx` file at `path` under /scratchpad or /input — ' +
    'write it with WriteLines first. The snippet must define a top-level ' +
    'component named `App`; the host mounts `<App/>` in a sandboxed iframe ' +
    'with React 18. `React` and the common hooks (`useState`, `useEffect`, ' +
    '`useRef`, `useMemo`, `useCallback`, `useReducer`, `useContext`) are ' +
    'available as globals; you may also `import` from `"react"` or ' +
    '`"react-dom"`. No other modules are available. Returns ' +
    '{ ok, compileErrors: [{message, line?, column?}], runtimeErrors: ' +
    '[{message, stack?}], path }. Compile errors come from typescript; ' +
    'runtime errors are collected for ~750ms after mount via ' +
    'window.onerror, unhandledrejection, and a top-level error boundary. ' +
    'On either kind of error, ReadLines the file at `path`, fix it with ' +
    'WriteLines, and call RunReact again.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Path to a .tsx file under /scratchpad or /input. The file must ' +
          'define a component named `App`. Use WriteLines first.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  promptMd: runReactMd,
  featureKey: 'runReact',
  parseInput: (raw) => ({ path: typeof raw.path === 'string' ? raw.path : '' }),
  run: (input) => runReactAtPath(input.path),
  panel: {
    onPending: (input) => panel.setPending('react', '', input.path),
    onRunning: () => panel.setRunning('react'),
    onAborted: () => panel.setAborted('react'),
    onResult: panel.setReactResult,
  },
};

const ListFilesTool: AgentTool<ListFilesInput, string | ToolError> = {
  name: 'ListFiles',
  description:
    'Recursively list text files and subdirectories under a path in ' +
    '/input or /scratchpad. Returns one absolute virtual path per line; ' +
    'directories end with a trailing "/". /input is the user\'s sandbox ' +
    'directory (read-only) and only shows supported extensions (csv, ' +
    'xls, xlsx, json, pdf, md, txt, docx, py, sql). /scratchpad is your ' +
    'OPFS scratch space (read/write) and shows a broader set of text ' +
    'extensions. Complementary to ListInputs: ListInputs shows the ' +
    'in-memory registry, ListFiles shows files on disk.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Virtual path to list under, e.g. "/input" or "/scratchpad".',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  promptMd: fileToolsMd,
  featureKey: 'fileTools',
  gated: false,
  parseInput: (raw) => ({ path: typeof raw.path === 'string' ? raw.path : '' }),
  run: async (input) => {
    try {
      const entries = await listFilesUnder(input.path);
      if (entries.length === 0) {
        return `(no text files or subdirectories under ${input.path})`;
      }
      return entries.join('\n');
    } catch (err) {
      return { error: errorMessage(err), path: input.path };
    }
  },
};

const ReadLinesTool: AgentTool<ReadLinesInput, string | ToolError> = {
  name: 'ReadLines',
  description:
    'Read lines [from..to] (1-indexed, inclusive) from a text file under ' +
    '/input or /scratchpad. Output is line-numbered with a header. Bounds ' +
    'are clamped to the file length. Use this to inspect a script before ' +
    'editing it with WriteLines, or to read source material under /input.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Virtual path of the file to read.',
      },
      from: {
        type: 'integer',
        description: '1-indexed first line to read.',
      },
      to: {
        type: 'integer',
        description: '1-indexed last line to read (inclusive). Must be >= from.',
      },
    },
    required: ['path', 'from', 'to'],
    additionalProperties: false,
  },
  promptMd: null,
  featureKey: 'fileTools',
  gated: false,
  parseInput: (raw) => ({
    path: typeof raw.path === 'string' ? raw.path : '',
    from: typeof raw.from === 'number' && Number.isInteger(raw.from) ? raw.from : NaN,
    to: typeof raw.to === 'number' && Number.isInteger(raw.to) ? raw.to : NaN,
  }),
  run: async (input) => {
    try {
      return await readLinesFromFile(input.path, input.from, input.to);
    } catch (err) {
      return { error: errorMessage(err), path: input.path };
    }
  },
};

const WriteLinesTool: AgentTool<WriteLinesInput, string | ToolError> = {
  name: 'WriteLines',
  description:
    'Replace lines [from..to] (1-indexed, inclusive) of a text file under ' +
    '/scratchpad with the provided content. Use to=from-1 to insert ' +
    'without replacing. To create a new file, set from=1, to=0. /input is ' +
    'read-only — WriteLines refuses any path outside /scratchpad. Parent ' +
    'directories are auto-created.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Virtual path of the file to write under /scratchpad.',
      },
      from: {
        type: 'integer',
        description: '1-indexed first line to replace. For a new file, use from=1.',
      },
      to: {
        type: 'integer',
        description:
          '1-indexed last line to replace (inclusive). Use to=from-1 to ' +
          'insert; to=0 with from=1 to create a new file.',
      },
      content: {
        type: 'string',
        description:
          'New content for the [from..to] range. May contain newlines; ' +
          'they replace the targeted range.',
      },
    },
    required: ['path', 'from', 'to', 'content'],
    additionalProperties: false,
  },
  promptMd: null,
  featureKey: 'fileTools',
  parseInput: (raw) => ({
    path: typeof raw.path === 'string' ? raw.path : '',
    from: typeof raw.from === 'number' && Number.isInteger(raw.from) ? raw.from : NaN,
    to: typeof raw.to === 'number' && Number.isInteger(raw.to) ? raw.to : NaN,
    content: typeof raw.content === 'string' ? raw.content : '',
  }),
  gateInput: (input) => ({
    path: input.path,
    from: input.from,
    to: input.to,
    contentPreview: input.content.slice(0, 200),
  }),
  run: async (input) => {
    try {
      const res = await writeLinesToFile(
        input.path,
        input.from,
        input.to,
        input.content,
      );
      const verb = res.created ? 'Created' : 'Updated';
      return `${verb} ${input.path} — ${res.totalLinesAfter} lines total.`;
    } catch (err) {
      return { error: errorMessage(err), path: input.path };
    }
  },
};

const RunSubAgentTool: AgentTool<RunSubAgentInput, unknown> = {
  name: 'RunSubAgent',
  description:
    'Run a self-contained subtask in a fresh, isolated LLM context. The ' +
    'sub-agent receives a short summary of this conversation as seed ' +
    'context, has access to the same tools you do (except `RunSubAgent` ' +
    'itself — sub-agents cannot recurse), and returns a single text ' +
    'answer. Returns `{ text: string }` on success or `{ error: string }`. ' +
    'Use it to delegate expensive sub-investigations whose intermediate ' +
    'output you do NOT need to keep in your own context. The sub-agent\'s ' +
    'UI runs in the SubAgents tab; only the returned text comes back to ' +
    'you.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'The task for the sub-agent. Be specific — the sub-agent only ' +
          'sees this prompt plus a short summary of the parent thread.',
      },
      task_label: {
        type: 'string',
        description:
          'Optional short label shown in the SubAgents tab. Defaults to a ' +
          'slice of the prompt.',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  promptMd: runSubAgentMd,
  featureKey: 'runSubAgent',
  parseInput: (raw) => ({
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    taskLabel: typeof raw.task_label === 'string' ? raw.task_label : undefined,
  }),
  // Dispatched via `runSubAgentDispatch`; pre-gate side effects and context
  // read mean the generic dispatcher path can't be used.
  run: async () => {
    throw new Error('RunSubAgent must be dispatched via runSubAgentDispatch');
  },
};

const ListInputsTool: AgentTool<Record<string, never>, RunListInputsResult> = {
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
    'is available or recover state after a page reload. Complementary to ' +
    'ListFiles — ListInputs shows the in-memory registry, ListFiles shows ' +
    'files on disk under /input and /scratchpad.',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  promptMd: null,
  featureKey: null,
  gated: false,
  parseInput: () => ({}),
  run: () => runListInputs(),
};

// Order matters: it drives the prompt-fragment concatenation order and the
// order tools are listed to the LLM.
const TOOL_LIST: ReadonlyArray<AgentTool<unknown, unknown, unknown>> = [
  LoadDataTool,
  RunSQLTool,
  RunPythonTool,
  RunReactTool,
  ListFilesTool,
  ReadLinesTool,
  WriteLinesTool,
  RunSubAgentTool,
  ListInputsTool,
] as ReadonlyArray<AgentTool<unknown, unknown, unknown>>;

const TOOL_REGISTRY: ReadonlyMap<string, AgentTool<unknown, unknown, unknown>> =
  new Map(TOOL_LIST.map((t) => [t.name, t]));

// ─── Derived exports ──────────────────────────────────────────────────────

export const AGENT_TOOLS: AgentToolSpec[] = TOOL_LIST.map(
  ({ name, description, parameters }) => ({ name, description, parameters }),
);

export function buildAgentTools(
  features: AgentPromptFeatures = DEFAULT_FEATURES,
): AgentToolSpec[] {
  return TOOL_LIST.filter(
    (t) => t.featureKey == null || !!features[t.featureKey],
  ).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function buildAgentSystemPrompt(
  features: AgentPromptFeatures = DEFAULT_FEATURES,
): string {
  const parts: string[] = [baseMd];
  for (const t of TOOL_LIST) {
    if (!t.promptMd) continue;
    if (t.featureKey != null && !features[t.featureKey]) continue;
    parts.push(t.promptMd);
  }
  return parts.map((s) => s.trim()).join('\n\n');
}

export const AGENT_SYSTEM_PROMPT = buildAgentSystemPrompt();

// ─── Dispatcher ───────────────────────────────────────────────────────────

/**
 * Dispatch a tool call by name. Used by `streamChat`'s tool-use loop.
 */
export async function runAgentTool(
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const tool = TOOL_REGISTRY.get(name);
  if (!tool) return { error: `Unknown tool: ${name}` } satisfies ToolError;

  const raw = (input ?? {}) as Record<string, unknown>;
  const parsed = tool.parseInput(raw);

  if (name === 'RunSubAgent') {
    return runSubAgentDispatch(parsed as RunSubAgentInput, signal);
  }

  if (tool.gated === false) {
    const res = await tool.run(parsed, signal);
    return tool.toWire ? tool.toWire(res, parsed) : res;
  }

  const res = await runWithGate<unknown>({
    toolName: tool.name,
    gateInput: tool.gateInput ? tool.gateInput(parsed) : parsed,
    signal,
    onPending: () => tool.panel?.onPending(parsed),
    onRunning: () => tool.panel?.onRunning(parsed),
    onAborted: () => tool.panel?.onAborted(parsed),
    onResult: (r) => tool.panel?.onResult(r, parsed),
    run: () => tool.run(parsed, signal),
  });
  return tool.toWire ? tool.toWire(res, parsed) : res;
}

/**
 * RunSubAgent has two needs the generic dispatcher can't model:
 *
 *   1. `prepareSubAgentRun` must run BEFORE the gate so the SubAgents tab
 *      shows the prompt during the Step/Play pause.
 *   2. `getSubAgentContext()` must be read at dispatch time — its
 *      `parentMessages` is captured by reference and `streamChat` mutates
 *      it after the gate releases.
 *
 * The empty-prompt guard fires before the dynamic imports — keep that
 * ordering; it matters on first-load latency.
 */
async function runSubAgentDispatch(
  input: RunSubAgentInput,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (!input.prompt.trim()) {
    return { error: 'RunSubAgent requires a non-empty `prompt`.' } satisfies ToolError;
  }
  const [{ runSubAgent, prepareSubAgentRun }, { getSubAgentContext }, subAgentStore] =
    await Promise.all([
      import('./subAgents/runSubAgent'),
      import('./subAgents/context'),
      import('./subAgents/store'),
    ]);
  const ctx = getSubAgentContext();
  if (!ctx) {
    return {
      error:
        'RunSubAgent is unavailable: no parent conversation context is registered.',
    } satisfies ToolError;
  }
  // Register the run + prompt up-front so the SubAgents tab shows the
  // instructions during the Step/Play pause, not after.
  const runId = prepareSubAgentRun({
    prompt: input.prompt,
    taskLabel: input.taskLabel,
  });
  return runWithGate({
    toolName: 'RunSubAgent',
    gateInput: { prompt: input.prompt, task_label: input.taskLabel },
    signal,
    onPending: () => panel.setActiveTab('subagents'),
    onAborted: () => subAgentStore.setStatus(runId, 'aborted'),
    onRunning: () => panel.setActiveTab('subagents'),
    run: () =>
      runSubAgent({
        prompt: input.prompt,
        taskLabel: input.taskLabel,
        config: ctx.config,
        parentMessages: ctx.parentMessages,
        features: ctx.features,
        signal,
        runId,
      }),
  });
}
