/**
 * Task corpus = a JSONL file under workspace/tasks/ where each line is one
 * task to run through a pipeline. Format:
 *
 *   {"taskId": "iris-001", "prompt": "Plot histogram of sepal_length",
 *    "dataset": "datasets/iris.csv", "difficulty": "easy"}
 *
 * - taskId: stable identifier; used for de-duplication across runs.
 * - prompt: the user-facing question.
 * - dataset: optional relative path under workspace/, surfaced to the
 *   teacher / student in the prompt so it knows what to LoadData. The
 *   harness does NOT auto-load it; that's the model's job.
 * - difficulty: optional metadata for filtering / stratified sampling.
 */
import { type Workspace, ensureSubdir, openJsonlAppender } from './workspace';

export interface CorpusTask {
  taskId: string;
  prompt: string;
  dataset?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  category?: string;
}

export class CorpusParseError extends Error {
  constructor(message: string, readonly file: string, readonly line: number) {
    super(`${file}:${line}: ${message}`);
  }
}

function parseTaskLine(line: string, file: string, lineNumber: number): CorpusTask | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new CorpusParseError(`invalid JSON: ${(err as Error).message}`, file, lineNumber);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new CorpusParseError('not a JSON object', file, lineNumber);
  }
  const obj = parsed as Record<string, unknown>;
  const taskId = typeof obj.taskId === 'string' ? obj.taskId : null;
  const prompt = typeof obj.prompt === 'string' ? obj.prompt : null;
  if (!taskId) throw new CorpusParseError('missing string "taskId"', file, lineNumber);
  if (!prompt) throw new CorpusParseError('missing string "prompt"', file, lineNumber);
  const task: CorpusTask = { taskId, prompt };
  if (typeof obj.dataset === 'string') task.dataset = obj.dataset;
  if (obj.difficulty === 'easy' || obj.difficulty === 'medium' || obj.difficulty === 'hard') {
    task.difficulty = obj.difficulty;
  }
  if (typeof obj.category === 'string') task.category = obj.category;
  return task;
}

/** Read every `*.jsonl` file under workspace/tasks/ and return all tasks. */
export async function readCorpus(workspace: Workspace): Promise<CorpusTask[]> {
  const tasks: CorpusTask[] = [];
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await ensureSubdir(workspace, 'tasks');
  } catch {
    return [];
  }
  for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (handle.kind !== 'file') continue;
    if (!name.endsWith('.jsonl')) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    const text = await file.text();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const task = parseTaskLine(lines[i], name, i + 1);
      if (task) tasks.push(task);
    }
  }
  return tasks;
}

/**
 * Read existing trajectory output and return the set of (sourcePipeline, taskId)
 * pairs already present, so a resumed run can skip them.
 *
 * Allowing the same taskId across different pipelines (gold + rejection) is
 * intentional — they're different runs.
 */
export async function readCompletedTaskIds(
  workspace: Workspace,
  outputFile: string,
  sourcePipeline: string,
): Promise<Set<string>> {
  const completed = new Set<string>();
  const parts = outputFile.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) return completed;
  let dir: FileSystemDirectoryHandle = workspace.root;
  try {
    for (const seg of parts) {
      dir = await dir.getDirectoryHandle(seg, { create: false });
    }
    const handle = await dir.getFileHandle(fileName, { create: false });
    const file = await handle.getFile();
    const text = await file.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { taskId?: unknown; sourcePipeline?: unknown };
        if (
          typeof obj.taskId === 'string' &&
          obj.sourcePipeline === sourcePipeline
        ) {
          completed.add(obj.taskId);
        }
      } catch {
        // Skip unparseable lines silently — they're someone else's problem.
      }
    }
  } catch {
    // No file yet → empty set.
  }
  return completed;
}

/** A run-scoped helper that owns the trajectories appender. */
export async function openTrajectoriesAppender(workspace: Workspace) {
  return openJsonlAppender(workspace, 'output/trajectories.jsonl');
}
