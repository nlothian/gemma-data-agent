import agentSystemPromptMd from './agentSystemPrompt.md?raw';

export type TabularResult = {
  columns: string[];
  rows: unknown[][];
};

export type ToolError = {
  error: string;
};

export type RunSQLResult = TabularResult | ToolError;

export type RunPythonResult =
  | {
      result: unknown;
      stdout: string;
      stderr: string;
    }
  | ToolError;

const NOT_IMPLEMENTED = 'Tool is not yet implemented.';

/**
 * Run a SQL query and return the result set as tabular data.
 *
 * Stub: the real implementation will land alongside the chat agent. For now
 * this only logs the call to the console and returns a `ToolError`.
 *
 * @param sql The SQL query to execute.
 * @returns A `TabularResult` with `columns` and `rows`, or a `ToolError`.
 */
export async function runSQL(sql: string): Promise<RunSQLResult> {
  console.log('[runSQL] called with:', sql);
  return { error: NOT_IMPLEMENTED };
}

/**
 * Execute a snippet of Python and return its return value alongside captured
 * stdout and stderr.
 *
 * Stub: the real implementation will land alongside the chat agent. For now
 * this only logs the call to the console and returns a `ToolError`.
 *
 * @param code The Python source to execute.
 * @returns The Python return value plus captured `stdout` and `stderr`, or a
 *   `ToolError` if execution failed before producing output.
 */
export async function runPython(code: string): Promise<RunPythonResult> {
  console.log('[runPython] called with:', code);
  return { error: NOT_IMPLEMENTED };
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

/**
 * Dispatch a tool call by name to the matching stub. Used by `streamChat`'s
 * tool-use loop. Returns the tool's result (which may itself be a `ToolError`).
 */
export async function runAgentTool(name: string, input: unknown): Promise<unknown> {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (name === 'RunSQL') {
    const sql = typeof obj.sql === 'string' ? obj.sql : '';
    return runSQL(sql);
  }
  if (name === 'RunPython') {
    const code = typeof obj.code === 'string' ? obj.code : '';
    return runPython(code);
  }
  return { error: `Unknown tool: ${name}` } satisfies ToolError;
}

export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: 'RunSQL',
    description:
      'Execute a SQL query and return the result set. On success returns ' +
      '{ columns: string[], rows: unknown[][] }. On failure returns ' +
      '{ error: string }.',
    parameters: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description: 'The SQL query to execute.',
        },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'RunPython',
    description:
      'Execute a snippet of Python. Returns { result, stdout, stderr } where ' +
      '`result` is the Python return value and `stdout`/`stderr` capture the ' +
      'program output streams. On failure returns { error: string }.',
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
