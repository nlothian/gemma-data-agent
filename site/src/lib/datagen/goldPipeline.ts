/**
 * Gold pipeline = run the teacher trajectory loop over every task in the
 * workspace's corpus, append each result to output/trajectories.jsonl,
 * skip any task already present (resumable).
 */
import { type LLMConfig } from '../../types/llm';
import { setMode as setToolGateMode } from '../toolDebugger';
import {
  readCorpus,
  readCompletedTaskIds,
  openTrajectoriesAppender,
  type CorpusTask,
} from './corpus';
import {
  resetRuntimeForTrajectory,
  runTeacherTrajectory,
  type TrajectoryRecord,
} from './trajectory';
import { type Workspace } from './workspace';

export interface GoldPipelineProgress {
  /** Total tasks in the corpus (after filtering). */
  total: number;
  /** Tasks skipped because they already exist in output. */
  skipped: number;
  /** Tasks completed in this run (regardless of outcome). */
  done: number;
  /** Tasks completed with outcome === 'completed'. */
  succeeded: number;
  /** Tasks completed with any other outcome. */
  failed: number;
  /** Last record written, for live display. */
  lastRecord?: TrajectoryRecord;
  /** Last task started, for "currently running" display. */
  current?: CorpusTask;
}

export interface RunGoldPipelineArgs {
  workspace: Workspace;
  mainConfig: LLMConfig;
  teacherModel: string;
  /** Hard cap; useful for smoke runs. Default: process the whole corpus. */
  maxTasks?: number;
  /** Filter tasks before running. */
  filter?: (task: CorpusTask) => boolean;
  signal?: AbortSignal;
  onProgress?: (p: GoldPipelineProgress) => void;
}

function buildPromptWithDatasetHint(task: CorpusTask, workspace: Workspace): string {
  if (!task.dataset) return task.prompt;
  // We don't pre-load — the teacher will emit a LoadData call. We just hand
  // it the path, exactly like the production agent system prompt describes
  // sandbox-relative paths.
  return (
    task.prompt +
    `\n\n(Dataset is available at sandbox path \`${task.dataset}\` under workspace \`${workspace.name}\`.)`
  );
}

export async function runGoldPipeline(args: RunGoldPipelineArgs): Promise<GoldPipelineProgress> {
  const corpus = await readCorpus(args.workspace);
  const filtered = args.filter ? corpus.filter(args.filter) : corpus;
  const completed = await readCompletedTaskIds(
    args.workspace,
    'output/trajectories.jsonl',
    'gold',
  );
  const queue = filtered.filter((t) => !completed.has(t.taskId));
  const cap = args.maxTasks ? Math.min(args.maxTasks, queue.length) : queue.length;
  const todo = queue.slice(0, cap);

  const progress: GoldPipelineProgress = {
    total: filtered.length,
    skipped: filtered.length - queue.length,
    done: 0,
    succeeded: 0,
    failed: 0,
  };
  args.onProgress?.(progress);

  // Keep tool dispatch unblocked for the duration of the run.
  setToolGateMode('running');
  const appender = await openTrajectoriesAppender(args.workspace);

  const runId = new Date().toISOString();

  for (const task of todo) {
    if (args.signal?.aborted) break;
    progress.current = task;
    args.onProgress?.({ ...progress });

    await resetRuntimeForTrajectory();

    const record = await runTeacherTrajectory({
      mainConfig: args.mainConfig,
      teacherModel: args.teacherModel,
      userPrompt: buildPromptWithDatasetHint(task, args.workspace),
      taskId: task.taskId,
      runId,
      sourcePipeline: 'gold',
      signal: args.signal,
    });

    await appender.append(record);

    progress.done += 1;
    if (record.outcome === 'completed') progress.succeeded += 1;
    else progress.failed += 1;
    progress.lastRecord = record;
    args.onProgress?.({ ...progress });
  }

  progress.current = undefined;
  args.onProgress?.({ ...progress });
  return progress;
}
