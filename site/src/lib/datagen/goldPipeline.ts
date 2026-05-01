/**
 * Gold pipeline = run the teacher trajectory loop over every task in the
 * output dir's corpus, append each result to <output_dir>/trajectories.jsonl,
 * skip any task already present (resumable).
 *
 * Datasets referenced by tasks live in the production sandbox; the agent's
 * LoadData tool resolves relative paths there exactly as it does for the
 * live agent.
 */
import { type LLMConfig } from '../../types/llm';
import { setMode as setToolGateMode } from '../toolDebugger';
import {
  readCorpus,
  readCompletedTaskIds,
  openTrajectoriesAppender,
  buildUserPrompt,
  type CorpusTask,
} from './corpus';
import {
  resetRuntimeForTrajectory,
  runTeacherTrajectory,
  type TrajectoryRecord,
} from './trajectory';
import { type OutputDir } from './outputDir';

export interface GoldPipelineProgress {
  total: number;
  skipped: number;
  done: number;
  succeeded: number;
  failed: number;
  lastRecord?: TrajectoryRecord;
  current?: CorpusTask;
}

export interface RunGoldPipelineArgs {
  outputDir: OutputDir;
  mainConfig: LLMConfig;
  teacherModel: string;
  maxTasks?: number;
  filter?: (task: CorpusTask) => boolean;
  signal?: AbortSignal;
  onProgress?: (p: GoldPipelineProgress) => void;
}

export async function runGoldPipeline(args: RunGoldPipelineArgs): Promise<GoldPipelineProgress> {
  const corpus = await readCorpus(args.outputDir);
  const filtered = args.filter ? corpus.filter(args.filter) : corpus;
  const completed = await readCompletedTaskIds(
    args.outputDir,
    'trajectories.jsonl',
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

  setToolGateMode('running');
  const appender = await openTrajectoriesAppender(args.outputDir);

  const runId = new Date().toISOString();

  for (const task of todo) {
    if (args.signal?.aborted) break;
    progress.current = task;
    args.onProgress?.({ ...progress });

    await resetRuntimeForTrajectory();

    const record = await runTeacherTrajectory({
      mainConfig: args.mainConfig,
      teacherModel: args.teacherModel,
      userPrompt: buildUserPrompt(task),
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
