/**
 * Parser for one teacher turn (per `prompts/teacherTurn.md`).
 *
 * Teacher emits prose followed by exactly one fenced code block tagged
 * either `tool_call` or `final`. Anything before the fence is the prose;
 * the fence body is JSON.
 *
 * Robustness: we accept some sloppiness because frontier models drift —
 * trailing prose after the fence is dropped, surrounding whitespace is
 * trimmed, and JSON parse errors are surfaced as a typed error so the
 * orchestrator can decide whether to retry.
 */

export interface TeacherTurnToolCall {
  kind: 'tool_call';
  prose: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface TeacherTurnFinal {
  kind: 'final';
  prose: string;
}

export type TeacherTurn = TeacherTurnToolCall | TeacherTurnFinal;

export class TeacherProtocolError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
  }
}

const FENCE_RE = /```(tool_call|final)\s*\n([\s\S]*?)\n```/;

export function parseTeacherTurn(raw: string): TeacherTurn {
  const match = FENCE_RE.exec(raw);
  if (!match) {
    throw new TeacherProtocolError(
      'Teacher response had no `tool_call` or `final` fenced block.',
      raw,
    );
  }
  const [fullMatch, tag, body] = match;
  const prose = raw.slice(0, match.index).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch (err) {
    throw new TeacherProtocolError(
      `Teacher response fenced JSON did not parse: ${(err as Error).message}`,
      raw,
    );
  }

  if (tag === 'final') {
    return { kind: 'final', prose };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new TeacherProtocolError(
      'Teacher tool_call body was not a JSON object.',
      raw,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const toolName = typeof obj.name === 'string' ? obj.name : null;
  if (!toolName) {
    throw new TeacherProtocolError(
      'Teacher tool_call body missing string "name".',
      raw,
    );
  }
  const args =
    obj.args && typeof obj.args === 'object' && !Array.isArray(obj.args)
      ? (obj.args as Record<string, unknown>)
      : {};

  // Sanity: catch the case where the teacher kept talking after the fence.
  // We don't reject — fullMatch is unused but keeping a lint marker so future
  // editors notice we deliberately ignore tail prose.
  void fullMatch;

  return { kind: 'tool_call', prose, toolName, args };
}
