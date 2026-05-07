// Caps oversized tool results before they re-enter the LLM prompt and bust
// the model's maxTokens budget (MediaPipe surfaces this as
// "Input is too long for the model to process: current_step + input_size
//  was not less than maxTokens").

export const TOOL_RESULT_MAX_CHARS = 10_000;

export const SIZE_CAPPED_TOOLS: ReadonlySet<string> = new Set([
  'RunPython',
  'RunReact',
  'RunSQL',
  'RunSubAgent',
]);

export const TOOL_RESULT_TOO_LARGE_MESSAGE =
  'Result Set was too large. Only small result sets can be returned. Using a SubAgent to process might help';

export function clampToolResultSize(
  toolName: string,
  resultStr: string,
): string {
  if (!SIZE_CAPPED_TOOLS.has(toolName)) return resultStr;
  if (resultStr.length <= TOOL_RESULT_MAX_CHARS) return resultStr;
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
