/**
 * Trajectory orchestrator: runs a multi-turn agent loop where the teacher
 * (a frontier model via OpenRouter) plays the assistant, and tool calls
 * execute against the *real* DuckDB / Pyodide runtime so results are
 * ground-truth.
 *
 * The trajectory record produced is an inspection-friendly JSON object,
 * one line per JSONL output. A downstream extractor converts it to
 * (prompt, completion) SFT pairs by replaying the turns through
 * `renderConversationForGemma` from `localLlm/toolPrompt`.
 */

import { type LLMConfig } from '../../types/llm';
import { runAgentTool, AGENT_TOOLS, AGENT_SYSTEM_PROMPT } from '../agentTools';
import { clearAllInputs } from '../duckdb';
import teacherTurnSystemPrompt from './prompts/teacherTurn.md?raw';
import { callTeacher } from './teacher';
import { parseTeacherTurn, TeacherProtocolError } from './teacherTurnParser';

export interface TrajectoryTurn {
  kind: 'tool_call' | 'final';
  prose: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  resultError?: string | null;
  durationMs: number;
}

export type TrajectoryOutcome =
  | 'completed'
  | 'max_iterations'
  | 'tool_error'
  | 'protocol_error'
  | 'aborted';

export interface TrajectoryRecord {
  schema: 'haw-trajectory-v1';
  runId: string;
  taskId: string;
  userPrompt: string;
  systemPrompt: string;
  turns: TrajectoryTurn[];
  outcome: TrajectoryOutcome;
  outcomeDetail?: string;
  sourcePipeline: 'gold' | 'rejection-chosen' | 'rejection-rejected' | 'adversarial';
  teacherModel: string | null;
  studentModel: string | null;
  createdAt: string;
  durationMs: number;
}

export interface RunTeacherTrajectoryArgs {
  mainConfig: LLMConfig;
  teacherModel: string;
  userPrompt: string;
  taskId: string;
  runId: string;
  sourcePipeline: TrajectoryRecord['sourcePipeline'];
  /** Hard cap on turns. Default 12. */
  maxIterations?: number;
  signal?: AbortSignal;
  onTurn?: (turn: TrajectoryTurn, index: number) => void;
}

const DEFAULT_MAX_ITERATIONS = 12;

/**
 * Build the user-side payload sent to the teacher each turn. We give it
 * the original user prompt plus a transcript of prior tool calls + results.
 */
function buildTeacherUserPayload(userPrompt: string, turns: TrajectoryTurn[]): string {
  const parts: string[] = [];
  parts.push(`# User question\n\n${userPrompt}`);
  if (turns.length > 0) {
    parts.push(`# Conversation so far`);
    for (const t of turns) {
      if (t.prose) parts.push(`Assistant text: ${t.prose}`);
      if (t.kind === 'tool_call') {
        parts.push(
          `Tool call: ${t.toolName}(${JSON.stringify(t.args ?? {})})\n` +
          `Tool result: ${JSON.stringify(t.result ?? null)}` +
          (t.resultError ? `\nTool ERROR: ${t.resultError}` : ''),
        );
      }
    }
    parts.push(`# Your turn\n\nProduce the next assistant turn following the protocol.`);
  } else {
    parts.push(`# Your turn\n\nProduce the first assistant turn following the protocol.`);
  }
  return parts.join('\n\n');
}

const COMBINED_SYSTEM_PROMPT = [
  teacherTurnSystemPrompt,
  '\n\n---\n',
  '## The agent system prompt you are emulating',
  '\n\n',
  AGENT_SYSTEM_PROMPT,
  '\n\n---\n',
  '## Tool schemas',
  '\n\n```json\n',
  JSON.stringify(AGENT_TOOLS, null, 2),
  '\n```\n',
].join('');

/**
 * Run one teacher-driven trajectory. Tool calls execute against the real
 * runtime — DuckDB tables and Pyodide state will mutate. Caller is
 * responsible for clearing the registry between trajectories if desired
 * (typically via `clearAllInputs()` from `lib/duckdb`).
 */
export async function runTeacherTrajectory(
  args: RunTeacherTrajectoryArgs,
): Promise<TrajectoryRecord> {
  const startedAt = Date.now();
  const turns: TrajectoryTurn[] = [];
  const maxIters = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  let outcome: TrajectoryOutcome = 'max_iterations';
  let outcomeDetail: string | undefined;

  for (let iter = 0; iter < maxIters; iter++) {
    if (args.signal?.aborted) {
      outcome = 'aborted';
      break;
    }

    const turnStarted = Date.now();
    const userPayload = buildTeacherUserPayload(args.userPrompt, turns);

    let raw: string;
    try {
      raw = await callTeacher(
        args.mainConfig,
        args.teacherModel,
        COMBINED_SYSTEM_PROMPT,
        userPayload,
      );
    } catch (err) {
      outcome = 'protocol_error';
      outcomeDetail = `Teacher API call failed: ${(err as Error).message}`;
      break;
    }

    let parsed;
    try {
      parsed = parseTeacherTurn(raw);
    } catch (err) {
      outcome = 'protocol_error';
      outcomeDetail =
        err instanceof TeacherProtocolError
          ? `${err.message} (raw: ${err.raw.slice(0, 200)})`
          : (err as Error).message;
      break;
    }

    if (parsed.kind === 'final') {
      const turn: TrajectoryTurn = {
        kind: 'final',
        prose: parsed.prose,
        durationMs: Date.now() - turnStarted,
      };
      turns.push(turn);
      args.onTurn?.(turn, turns.length - 1);
      outcome = 'completed';
      break;
    }

    // Tool call — execute against the real runtime.
    let result: unknown;
    let resultError: string | null = null;
    try {
      result = await runAgentTool(parsed.toolName, parsed.args, args.signal);
      if (result && typeof result === 'object' && 'error' in result) {
        // Tool surfaces errors via { error: string } — don't fail the
        // trajectory here; the teacher should see the error and recover.
        resultError = String((result as { error: unknown }).error);
      }
    } catch (err) {
      // Hard failure: tool runner threw. Record and stop.
      const turn: TrajectoryTurn = {
        kind: 'tool_call',
        prose: parsed.prose,
        toolName: parsed.toolName,
        args: parsed.args,
        result: null,
        resultError: (err as Error).message,
        durationMs: Date.now() - turnStarted,
      };
      turns.push(turn);
      args.onTurn?.(turn, turns.length - 1);
      outcome = 'tool_error';
      outcomeDetail = `Hard tool failure: ${(err as Error).message}`;
      break;
    }

    const turn: TrajectoryTurn = {
      kind: 'tool_call',
      prose: parsed.prose,
      toolName: parsed.toolName,
      args: parsed.args,
      result,
      resultError,
      durationMs: Date.now() - turnStarted,
    };
    turns.push(turn);
    args.onTurn?.(turn, turns.length - 1);
  }

  return {
    schema: 'haw-trajectory-v1',
    runId: args.runId,
    taskId: args.taskId,
    userPrompt: args.userPrompt,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    turns,
    outcome,
    outcomeDetail,
    sourcePipeline: args.sourcePipeline,
    teacherModel: args.teacherModel,
    studentModel: null,
    createdAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/** Convenience: clear the in-app registry so a fresh trajectory starts hermetic. */
export async function resetRuntimeForTrajectory(): Promise<void> {
  await clearAllInputs();
}
