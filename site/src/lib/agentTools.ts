import agentSystemPromptMd from './agentSystemPrompt.md?raw';
import { isBrowser } from './browser';
import { awaitToolGate } from './toolDebugger';
import * as panel from './executionPanelStore';
import { MAX_DISPLAY_ROWS, type DataFormat, type LoadedTable, type TabularResult } from './duckdb';

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

export type RunLoadDataResult = LoadedTable | ToolError;

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
      registerArrowTable,
      runStreamingSql,
    } = await import('./duckdb');
    if (registerAs) {
      const { conn } = await getDuckDB();
      const table = await conn.query(sql);
      registerArrowTable(registerAs, arrowTableToIPC(table));
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
    const { listArrowTables, getArrowTable, registerArrowTable, loadArrowIntoDuckDB } = duck;

    const inputs = listArrowTables()
      .map(({ name }) => {
        const buffer = getArrowTable(name);
        return buffer ? { name, buffer } : null;
      })
      .filter((x): x is { name: string; buffer: Uint8Array } => x !== null);

    const res = await runInPyodide(code, inputs);

    if (res.ok) {
      if (res.arrowTables && res.arrowTables.length > 0) {
        for (const { name, buffer } of res.arrowTables) {
          registerArrowTable(name, buffer);
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
  if (name === 'LoadData') {
    const url = typeof obj.url === 'string' ? obj.url : '';
    const tableName = typeof obj.table_name === 'string' ? obj.table_name : '';
    const fmt = typeof obj.format === 'string' ? obj.format : undefined;
    const format =
      fmt === 'csv' || fmt === 'json' || fmt === 'parquet' ? fmt : undefined;
    return runWithGate<RunLoadDataResult>({
      toolName: 'LoadData',
      gateInput: { url, table_name: tableName, format },
      signal,
      onPending: () => panel.setDataPending(tableName, url),
      onAborted: () => panel.setAborted('data'),
      onRunning: () => panel.setRunning('data'),
      onResult: panel.setDataResult,
      run: () => runLoadData(url, tableName, format),
    });
  }
  return { error: `Unknown tool: ${name}` } satisfies ToolError;
}

export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: 'LoadData',
    description:
      'Load a remote CSV, JSON, or Parquet file into DuckDB as a table. ' +
      'Returns { name, url, format, schema: [{name,type}], rowCount } on ' +
      'success and { error } on failure. The remote server must send CORS ' +
      'headers (Access-Control-Allow-Origin); if not, the tool returns a ' +
      'CORS-aware error — surface that error to the user verbatim, do not ' +
      'retry the same URL. Prefer this over fetching files inside RunPython.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Public URL of the data file to load.',
        },
        table_name: {
          type: 'string',
          description:
            'DuckDB table name to create. Must match [A-Za-z_][A-Za-z0-9_]*.',
        },
        format: {
          type: 'string',
          enum: ['csv', 'json', 'parquet'],
          description:
            'Optional format override; inferred from the URL extension otherwise.',
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
      'use `register_as` to route the full result to RunPython. If ' +
      '`register_as` is set, the full result is stored as an Arrow IPC ' +
      'buffer that subsequent RunPython calls can read via ' +
      'arrow_inputs["<register_as>"].',
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
      'failure returns { error, stdout, stderr }. Tables registered by prior ' +
      'RunSQL calls are available as arrow_inputs[name]: bytes. Assigning ' +
      'arrow_tables = {"name": ipc_bytes, ...} loads each entry into DuckDB.',
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
];

export const AGENT_SYSTEM_PROMPT = agentSystemPromptMd.trim();
