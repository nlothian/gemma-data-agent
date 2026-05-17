// Caps oversized tool results before they re-enter the LLM prompt and bust
// the model's maxTokens budget (MediaPipe surfaces this as
// "Input is too long for the model to process: current_step + input_size
//  was not less than maxTokens").
//
// For diagnostic-shaped results ({ error, stdout, stderr } — e.g. RunPython),
// an oversized payload is salvaged by truncating those fields head+tail rather
// than discarded wholesale, so the model still sees the real error/traceback.
// Only if the result is still over the cap afterwards (a huge non-diagnostic
// field) do we fall back to the "too large" envelope.

export const TOOL_RESULT_MAX_CHARS = 10_000;

export const SIZE_CAPPED_TOOLS: ReadonlySet<string> = new Set([
  'GrepCodebase',
  'ReadLines',
  'RunPython',
  'RunReact',
  'RunSQL',
  'RunSubAgent',
]);

export const TOOL_RESULT_TOO_LARGE_MESSAGE =
  'Result Set was too large. Only small result sets can be returned. Using a SubAgent to process might help';

/** Per-field char cap for salvaged { error, stdout, stderr } payloads. */
export const TOOL_RESULT_FIELD_CHAR_CAP = 500;

const TRUNCATABLE_FIELDS = ['error', 'stdout', 'stderr'] as const;

/**
 * Head+tail truncation: keep the first and last `cap/2` chars with a marker in
 * between. Tracebacks carry the exception type near the top and the actual
 * failure at the bottom, so keeping both ends preserves the useful signal.
 * Non-strings (and strings already within `cap`) pass through unchanged.
 */
function truncateField(value: unknown, cap: number): unknown {
  if (typeof value !== 'string' || value.length <= cap) return value;
  const half = Math.floor(cap / 2);
  return (
    `${value.slice(0, half)}` +
    `…[truncated, full=${value.length} chars]…` +
    `${value.slice(value.length - half)}`
  );
}

/**
 * Try to salvage an oversized result by truncating its { error, stdout, stderr }
 * fields. Returns the reserialized string, or null when the payload isn't a
 * JSON object carrying any of those fields (caller then uses the envelope).
 */
function shrinkDiagnosticResult(resultStr: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultStr);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (!TRUNCATABLE_FIELDS.some((k) => typeof obj[k] === 'string')) {
    return null;
  }
  const next: Record<string, unknown> = { ...obj };
  for (const k of TRUNCATABLE_FIELDS) {
    next[k] = truncateField(obj[k], TOOL_RESULT_FIELD_CHAR_CAP);
  }
  return JSON.stringify(next);
}

export function clampToolResultSize(
  toolName: string,
  resultStr: string,
): string {
  if (!SIZE_CAPPED_TOOLS.has(toolName)) return resultStr;
  if (resultStr.length <= TOOL_RESULT_MAX_CHARS) return resultStr;
  const shrunk = shrinkDiagnosticResult(resultStr);
  if (shrunk !== null && shrunk.length <= TOOL_RESULT_MAX_CHARS) {
    return shrunk;
  }
  return JSON.stringify({ error: TOOL_RESULT_TOO_LARGE_MESSAGE });
}

/**
 * Rough char→token estimate used when checking whether a tool result would
 * blow the model's context budget. Matches the heuristic the user asked for
 * (chars / 2). Deliberately conservative: real tokens-per-char varies by
 * tokenizer but ~2 chars/token is a reasonable upper bound for English /
 * JSON-shaped text.
 */
export function estimateResultTokens(resultStr: string): number {
  return Math.ceil(resultStr.length / 2);
}
