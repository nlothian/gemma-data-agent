/**
 * Tool registry + dispatcher for the Explainer Conversation.
 *
 * Unlike the main agent's tool registry (`agentTools.ts`), these are
 * read-only research tools backed by the bundled sourcecode mirror. They do
 * NOT pass through `runWithGate` — the user shouldn't have to step through
 * each grep/read; the explainer should just answer.
 */

import type { AgentToolSpec, ToolError } from './agentTools';
import { readSourceFile } from './sourcecode/readSource';
import { runGrep } from './sourcecode/runGrep';
import { showSourcecodeRange } from './sourcecode/showRange';

const READLINES_MAX_LINES = 400;
const GREP_MAX_RESULTS = 50;

export const EXPLAINER_TOOLS: AgentToolSpec[] = [
  {
    name: 'GrepCodebase',
    description:
      "Search the project source for a regex pattern. Searches the bundled " +
      "sourcecode mirror — `site/src/**` (TypeScript/TSX, CSS, MDX, JSON), " +
      "the repo's root markdown files, and `docs/`. Returns up to " +
      `${GREP_MAX_RESULTS} matches as { path, line, lineText }. Use this to ` +
      "locate where a feature is implemented, then call ReadLines on the " +
      "most promising path to read the surrounding code. The 'flags' " +
      "argument may contain 'i' (case-insensitive) and/or 'm' (multiline " +
      "anchors); other flags are rejected.",
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'JavaScript-flavoured regular expression. Backslashes must be escaped for JSON.',
        },
        flags: {
          type: 'string',
          description: "Subset of 'i' and 'm'. Empty/omitted = no flags.",
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'ReadLines',
    description:
      "Read a slice of a source file from the bundled mirror. Inputs are " +
      "1-based line numbers (inclusive). Returns the requested range with " +
      "each line prefixed by `<line-number>: ` so you can cite specific " +
      "lines back to the user via @sourcecode markdown links. The range is " +
      `capped at ${READLINES_MAX_LINES} lines; if you ask for more, the ` +
      "result will be truncated and `truncated: true` will be set.",
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Path inside the project, e.g. 'site/src/lib/streamChat.ts' (no leading slash).",
        },
        startLine: { type: 'number', description: '1-based first line (inclusive).' },
        endLine: { type: 'number', description: '1-based last line (inclusive).' },
      },
      required: ['path', 'startLine', 'endLine'],
    },
  },
  {
    name: 'HighlightSourcecode',
    description:
      "Open the Sourcecode pane on a file with a line range highlighted. " +
      "Use this to direct the user's attention to the single most important " +
      "snippet in your answer. Side-effect only: it does NOT return the " +
      "code. Collapses the execution pane to the side rail so the explainer " +
      "fills the height. Call at most once per reply, on the most relevant " +
      "range. Inline citations to other files should use @sourcecode " +
      "markdown links instead.",
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Path inside the project, e.g. 'site/src/lib/streamChat.ts'.",
        },
        startLine: { type: 'number', description: '1-based first line.' },
        endLine: {
          type: 'number',
          description: '1-based last line (defaults to startLine for a single-line highlight).',
        },
      },
      required: ['path', 'startLine'],
    },
  },
];

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.floor(v);
}

export async function runExplainerTool(
  name: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) {
    return { error: 'aborted' } satisfies ToolError;
  }
  const obj = (input ?? {}) as Record<string, unknown>;

  if (name === 'GrepCodebase') {
    const pattern = asString(obj.pattern);
    if (!pattern) return { error: 'GrepCodebase requires a non-empty `pattern`.' } satisfies ToolError;
    const flags = asString(obj.flags) ?? '';
    try {
      const results = await runGrep({ pattern, flags, max: GREP_MAX_RESULTS, signal });
      return {
        results: results.map((r) => ({ path: r.path, line: r.line, lineText: r.lineText })),
        count: results.length,
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } satisfies ToolError;
    }
  }

  if (name === 'ReadLines') {
    const path = asString(obj.path);
    const startLine = asInt(obj.startLine);
    const endLineRaw = asInt(obj.endLine);
    if (!path) return { error: 'ReadLines requires a `path` string.' } satisfies ToolError;
    if (startLine == null || startLine < 1) {
      return { error: 'ReadLines requires `startLine` >= 1.' } satisfies ToolError;
    }
    if (endLineRaw == null || endLineRaw < startLine) {
      return { error: 'ReadLines requires `endLine` >= startLine.' } satisfies ToolError;
    }
    let truncated = false;
    let endLine = endLineRaw;
    if (endLine - startLine + 1 > READLINES_MAX_LINES) {
      endLine = startLine + READLINES_MAX_LINES - 1;
      truncated = true;
    }
    let text: string;
    try {
      text = await readSourceFile(path);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } satisfies ToolError;
    }
    const lines = text.split('\n');
    const totalLines = lines.length;
    const sliceEnd = Math.min(lines.length, endLine);
    const sliceStart = Math.min(lines.length, startLine - 1);
    const slice = lines.slice(sliceStart, sliceEnd);
    const numbered = slice.map((line, i) => `${sliceStart + i + 1}: ${line}`).join('\n');
    return {
      path,
      startLine,
      endLine: sliceStart + slice.length,
      totalLines,
      content: numbered,
      truncated,
    };
  }

  if (name === 'HighlightSourcecode') {
    const path = asString(obj.path);
    const startLine = asInt(obj.startLine);
    const endLineRaw = asInt(obj.endLine);
    if (!path) return { error: 'HighlightSourcecode requires a `path` string.' } satisfies ToolError;
    if (startLine == null || startLine < 1) {
      return { error: 'HighlightSourcecode requires `startLine` >= 1.' } satisfies ToolError;
    }
    const endLine = endLineRaw == null ? startLine : Math.max(startLine, endLineRaw);
    showSourcecodeRange({ path, startLine, endLine });
    return { ok: true, path, startLine, endLine };
  }

  return { error: `Unknown explainer tool: ${name}` } satisfies ToolError;
}
