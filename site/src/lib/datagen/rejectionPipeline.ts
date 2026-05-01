/**
 * Rejection-sampling pipeline:
 *  1. For each task in the corpus, look up its gold final answer (from
 *     <output_dir>/trajectories.jsonl, source 'gold').
 *  2. Run N student rollouts via the production local-Gemma path.
 *  3. Score each rollout: parse-OK + no tool errors + finished + judge says
 *     final answer is correct → success; otherwise the failure reason.
 *  4. Build DPO pairs (de-duplicated cross product of distinct successes
 *     and failures), append to <output_dir>/dpo.jsonl.
 *  5. Append every student rollout (success or fail) to
 *     <output_dir>/trajectories.jsonl with sourcePipeline='rejection-*'.
 */
import { type LLMConfig } from '../../types/llm';
import { setMode as setToolGateMode } from '../toolDebugger';
import { type LocalGemmaId } from '../localLlm/models';
import { AGENT_SYSTEM_PROMPT } from '../agentTools';
import {
  readCorpus,
  buildUserPrompt,
  type CorpusTask,
} from './corpus';
import { resetRuntimeForTrajectory } from './trajectory';
import {
  runStudentRollout,
  type StudentRolloutResult,
} from './studentRollout';
import { judgeAnswer, JudgeProtocolError } from './judge';
import {
  buildDpoPairs,
  type FailureReason,
  type ScoredRollout,
} from './dpo';
import {
  openJsonlAppender,
  type OutputDir,
} from './outputDir';

export interface RejectionPipelineProgress {
  total: number;
  skipped: number;
  done: number;
  pairsEmitted: number;
  successes: number;
  failures: number;
  current?: CorpusTask;
  lastNote?: string;
}

export interface RunRejectionPipelineArgs {
  outputDir: OutputDir;
  mainConfig: LLMConfig;
  studentModelId: LocalGemmaId;
  judgeModel: string;
  rolloutsPerTask: number;
  maxTasks?: number;
  filter?: (task: CorpusTask) => boolean;
  signal?: AbortSignal;
  onProgress?: (p: RejectionPipelineProgress) => void;
}

interface GoldAnswerIndex {
  byTaskId: Map<string, string>;
}

async function readGoldAnswers(outputDir: OutputDir): Promise<GoldAnswerIndex> {
  const byTaskId = new Map<string, string>();
  try {
    const handle = await outputDir.root.getFileHandle('trajectories.jsonl', { create: false });
    const file = await handle.getFile();
    const text = await file.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as {
          taskId?: unknown;
          sourcePipeline?: unknown;
          outcome?: unknown;
          turns?: unknown;
        };
        if (
          typeof obj.taskId !== 'string' ||
          obj.sourcePipeline !== 'gold' ||
          obj.outcome !== 'completed' ||
          !Array.isArray(obj.turns)
        ) continue;
        // Final-answer extraction from the trajectory: the last 'final' turn,
        // or the last prose if no explicit final.
        let finalAnswer = '';
        for (const turn of obj.turns) {
          if (turn && typeof turn === 'object' && 'kind' in turn) {
            const t = turn as { kind: unknown; prose?: unknown };
            if (t.kind === 'final' && typeof t.prose === 'string') {
              finalAnswer = t.prose;
            }
          }
        }
        if (finalAnswer) byTaskId.set(obj.taskId, finalAnswer);
      } catch {
        // skip
      }
    }
  } catch {
    // No file → empty index. Caller decides whether to error or warm-start.
  }
  return { byTaskId };
}

async function readAttemptedRejectionTaskIds(outputDir: OutputDir): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    const handle = await outputDir.root.getFileHandle('trajectories.jsonl', { create: false });
    const file = await handle.getFile();
    const text = await file.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { taskId?: unknown; sourcePipeline?: unknown };
        if (typeof obj.taskId !== 'string') continue;
        if (
          obj.sourcePipeline === 'rejection-chosen' ||
          obj.sourcePipeline === 'rejection-rejected'
        ) {
          // taskId of a student rollout looks like `<base>#<index>`.
          const base = obj.taskId.split('#')[0];
          seen.add(base);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // no file → empty set
  }
  return seen;
}

function classifyFailure(
  result: StudentRolloutResult,
): FailureReason | null {
  if (result.signals.hardError) return 'hard_error';
  if (!result.signals.parseOk) return 'parse_error';
  if (result.signals.toolErrors.length > 0) return 'tool_error';
  if (result.signals.reachedMaxIterations) return 'max_iterations';
  return null;
}

export async function runRejectionPipeline(
  args: RunRejectionPipelineArgs,
): Promise<RejectionPipelineProgress> {
  const corpus = await readCorpus(args.outputDir);
  const filtered = args.filter ? corpus.filter(args.filter) : corpus;
  const goldAnswers = await readGoldAnswers(args.outputDir);
  const attempted = await readAttemptedRejectionTaskIds(args.outputDir);

  // We can only score a task whose gold final answer we know.
  const queue = filtered.filter(
    (t) => goldAnswers.byTaskId.has(t.taskId) && !attempted.has(t.taskId),
  );
  const cap = args.maxTasks ? Math.min(args.maxTasks, queue.length) : queue.length;
  const todo = queue.slice(0, cap);

  const progress: RejectionPipelineProgress = {
    total: filtered.length,
    skipped: filtered.length - queue.length,
    done: 0,
    pairsEmitted: 0,
    successes: 0,
    failures: 0,
  };
  args.onProgress?.(progress);

  setToolGateMode('running');

  const trajectoriesAppender = await openJsonlAppender(
    args.outputDir,
    'trajectories.jsonl',
  );
  const dpoAppender = await openJsonlAppender(
    args.outputDir,
    'dpo.jsonl',
  );

  const runId = new Date().toISOString();

  for (const task of todo) {
    if (args.signal?.aborted) break;
    progress.current = task;
    args.onProgress?.({ ...progress });

    const referenceAnswer = goldAnswers.byTaskId.get(task.taskId)!;
    const scored: ScoredRollout[] = [];

    for (let i = 0; i < args.rolloutsPerTask; i++) {
      if (args.signal?.aborted) break;
      progress.lastNote = `task ${task.taskId} rollout ${i + 1}/${args.rolloutsPerTask}`;
      args.onProgress?.({ ...progress });

      // Fresh registry per rollout so prior tool side effects don't bleed.
      await resetRuntimeForTrajectory();

      const result = await runStudentRollout({
        mainConfig: args.mainConfig,
        studentModelId: args.studentModelId,
        userPrompt: buildUserPrompt(task),
        taskId: task.taskId,
        runId,
        rolloutIndex: i,
        sourcePipeline: 'rejection-chosen', // updated after scoring
        signal: args.signal,
      });

      const failureReason = classifyFailure(result);
      let outcome: ScoredRollout['outcome'];
      let judgeReasoning: string | undefined;

      if (failureReason) {
        outcome = failureReason;
      } else {
        // Ran cleanly; ask the judge.
        try {
          const verdict = await judgeAnswer({
            mainConfig: args.mainConfig,
            judgeModel: args.judgeModel,
            userQuestion: task.prompt,
            referenceAnswer,
            candidateAnswer: result.signals.finalAnswer,
          });
          outcome = verdict.correct ? 'success' : 'judge_incorrect';
          judgeReasoning = verdict.reasoning;
        } catch (err) {
          // Judge call itself failed — record as a failure with hard_error so
          // the trajectory isn't lost, but flag in lastNote.
          progress.lastNote =
            err instanceof JudgeProtocolError
              ? `judge protocol error: ${err.message}`
              : `judge call failed: ${(err as Error).message}`;
          outcome = 'hard_error';
        }
      }

      // Tag the rollout's record with the right pipeline label and write it.
      const sourcePipeline =
        outcome === 'success' ? 'rejection-chosen' : 'rejection-rejected';
      const taggedRecord = {
        ...result.record,
        sourcePipeline,
        outcomeDetail: judgeReasoning ?? result.record.outcomeDetail,
      };
      await trajectoriesAppender.append(taggedRecord);

      scored.push({
        rolloutIndex: i,
        historyText: result.historyText,
        displayText: result.displayText,
        finalAnswer: result.signals.finalAnswer,
        outcome,
        judgeReasoning,
      });

      if (outcome === 'success') progress.successes += 1;
      else progress.failures += 1;
    }

    const pairs = buildDpoPairs({
      runId,
      taskId: task.taskId,
      userPrompt: task.prompt,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      rollouts: scored,
      studentModel: args.studentModelId,
      judgeModel: args.judgeModel,
    });
    for (const pair of pairs) {
      await dpoAppender.append(pair);
    }
    progress.pairsEmitted += pairs.length;
    progress.done += 1;
    args.onProgress?.({ ...progress });
  }

  progress.current = undefined;
  args.onProgress?.({ ...progress });
  return progress;
}
