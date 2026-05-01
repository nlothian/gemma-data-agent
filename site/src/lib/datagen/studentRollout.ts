/**
 * Student rollout: invokes the production local-Gemma path against a single
 * user prompt and returns a structured trajectory record + the verifier
 * signals (parse-OK, tool errors, max-iterations, hard error).
 *
 * The student goes through `streamLocalGemma`, which is the EXACT same path
 * the chat UI uses — so failure modes captured here are the failure modes
 * users see. That's the whole point of doing this in-browser via LiteRT.
 */
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS } from '../agentTools';
import {
  parseAssistantContent,
  type AssistantSegment,
} from '../parseAssistantContent';
import { streamLocalGemma } from '../localLlm/streamLocalGemma';
import { type LocalGemmaId } from '../localLlm/models';
import {
  LOCAL_GEMMA_ENDPOINT,
  type LLMConfig,
} from '../../types/llm';
import { type TrajectoryRecord, type TrajectoryTurn } from './trajectory';

const MAX_ITER_MARKER = '[Reached max tool iterations.]';

export interface StudentRolloutSignals {
  parseOk: boolean;
  toolErrors: string[];
  reachedMaxIterations: boolean;
  hardError: string | null;
  finalAnswer: string;
  durationMs: number;
}

export interface StudentRolloutResult {
  record: TrajectoryRecord;
  signals: StudentRolloutSignals;
  /** Replay-format text — the SFT training target. */
  historyText: string;
  /** Display-format text — for human inspection. */
  displayText: string;
  /** Parsed segments derived from displayText via `parseAssistantContent`. */
  segments: AssistantSegment[];
}

export interface RunStudentRolloutArgs {
  mainConfig: LLMConfig;
  studentModelId: LocalGemmaId;
  userPrompt: string;
  taskId: string;
  runId: string;
  rolloutIndex: number;
  sourcePipeline: TrajectoryRecord['sourcePipeline'];
  signal?: AbortSignal;
}

function studentConfig(base: LLMConfig, modelId: LocalGemmaId): LLMConfig {
  return {
    ...base,
    activeEndpoint: LOCAL_GEMMA_ENDPOINT,
    models: { ...base.models, [LOCAL_GEMMA_ENDPOINT]: modelId },
  };
}

function extractFinalAnswer(segments: AssistantSegment[]): string {
  // Last text segment after the last tool segment (or the only text segment
  // if there were no tools).
  let lastText = '';
  for (const seg of segments) {
    if (seg.kind === 'text') lastText = seg.text;
    if (seg.kind === 'tool') lastText = '';
  }
  return lastText.trim();
}

function extractToolErrors(segments: AssistantSegment[]): string[] {
  const errs: string[] = [];
  for (const seg of segments) {
    if (seg.kind !== 'tool' || seg.result == null) continue;
    try {
      const parsed = JSON.parse(seg.result);
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        errs.push(String((parsed as { error: unknown }).error));
      }
    } catch {
      // Result wasn't JSON — agent runtime always emits JSON, so a non-JSON
      // result indicates a malformed dispatch. Treat as an error.
      errs.push(`non-JSON tool result: ${seg.result.slice(0, 100)}`);
    }
  }
  return errs;
}

function segmentsToTurns(segments: AssistantSegment[]): TrajectoryTurn[] {
  // Group consecutive (text?, tool) into one tool_call turn. A trailing text
  // segment with no following tool is the final turn.
  const turns: TrajectoryTurn[] = [];
  let pendingProse = '';
  for (const seg of segments) {
    if (seg.kind === 'thinking') continue; // not modelled in TrajectoryTurn yet
    if (seg.kind === 'text') {
      pendingProse += seg.text;
      continue;
    }
    // tool segment
    let parsedArgs: Record<string, unknown> = {};
    try {
      // The display format stores args as a Gemma-wire substring inside
      // parens — not round-trippable to JSON. Best-effort: store the raw
      // args string under a single field so the record is still useful.
      parsedArgs = { _raw: seg.args };
    } catch {
      // unreachable
    }
    let result: unknown = null;
    let resultError: string | null = null;
    if (seg.result != null) {
      try {
        result = JSON.parse(seg.result);
        if (result && typeof result === 'object' && 'error' in result) {
          resultError = String((result as { error: unknown }).error);
        }
      } catch {
        result = seg.result;
      }
    }
    turns.push({
      kind: 'tool_call',
      prose: pendingProse.trim(),
      toolName: seg.name,
      args: parsedArgs,
      result,
      resultError,
      durationMs: 0,
    });
    pendingProse = '';
  }
  if (pendingProse.trim()) {
    turns.push({ kind: 'final', prose: pendingProse.trim(), durationMs: 0 });
  }
  return turns;
}

export async function runStudentRollout(
  args: RunStudentRolloutArgs,
): Promise<StudentRolloutResult> {
  const startedAt = Date.now();
  const cfg = studentConfig(args.mainConfig, args.studentModelId);

  let displayText = '';
  let historyText = '';
  let hardError: string | null = null;

  await new Promise<void>((resolve) => {
    streamLocalGemma({
      config: cfg,
      messages: [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        { role: 'user', content: args.userPrompt },
      ],
      tools: AGENT_TOOLS,
      signal: args.signal,
      onToken: (delta) => {
        displayText += delta;
      },
      onHistoryDelta: (delta) => {
        historyText += delta;
      },
      onDone: () => resolve(),
      onError: (err) => {
        hardError = err.message;
        resolve();
      },
    }).catch((err) => {
      hardError = err instanceof Error ? err.message : String(err);
      resolve();
    });
  });

  const reachedMaxIterations = displayText.includes(MAX_ITER_MARKER);
  const segments = parseAssistantContent(displayText);
  const finalAnswer = extractFinalAnswer(segments);
  const toolErrors = extractToolErrors(segments);
  const durationMs = Date.now() - startedAt;

  // parseOk: did our segment parser swallow the whole thing? A malformed
  // tool-call line gets emitted as plain text (see parseAssistantContent
  // around the "Malformed" branch); we can't directly detect that, so we
  // approximate: if displayText contains the call marker `\n\n→ ` AND a
  // segment of kind 'tool' didn't get produced for every occurrence,
  // something's wrong.
  const callMarkerCount = (displayText.match(/\n\n→ /g) || []).length;
  const toolSegmentCount = segments.filter((s) => s.kind === 'tool').length;
  const parseOk = hardError == null && callMarkerCount === toolSegmentCount;

  const turns = segmentsToTurns(segments);

  const record: TrajectoryRecord = {
    schema: 'haw-trajectory-v1',
    runId: args.runId,
    taskId: `${args.taskId}#${args.rolloutIndex}`,
    userPrompt: args.userPrompt,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    turns,
    outcome:
      hardError != null
        ? 'tool_error'
        : reachedMaxIterations
          ? 'max_iterations'
          : toolErrors.length > 0
            ? 'tool_error'
            : 'completed',
    outcomeDetail: hardError ?? (toolErrors.length > 0 ? toolErrors[0] : undefined),
    sourcePipeline: args.sourcePipeline,
    teacherModel: null,
    studentModel: args.studentModelId,
    createdAt: new Date(startedAt).toISOString(),
    durationMs,
  };

  return {
    record,
    signals: {
      parseOk,
      toolErrors,
      reachedMaxIterations,
      hardError,
      finalAnswer,
      durationMs,
    },
    historyText,
    displayText,
    segments,
  };
}
