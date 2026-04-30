/**
 * Task generation: ask the teacher for an array of {prompt, category,
 * difficulty} entries given a dataset description, write them as a
 * JSONL file under tasks/ in the workspace.
 *
 * Two flavors:
 *  - 'normal' uses prompts/teacherTaskGen.md (mixed difficulty, broad
 *    coverage)
 *  - 'adversarial' uses prompts/adversarialTaskGen.md (targets known
 *    weak spots of small agents)
 */
import { type LLMConfig } from '../../types/llm';
import { callTeacher } from './teacher';
import { type OutputDir, openJsonlAppender } from './outputDir';
import normalPrompt from './prompts/teacherTaskGen.md?raw';
import adversarialPrompt from './prompts/adversarialTaskGen.md?raw';

export type TaskGenFlavor = 'normal' | 'adversarial';

export interface DatasetDescription {
  /** Workspace-relative path to the dataset file, used as the dataset hint. */
  path: string;
  /** Short prose description of the schema and a few sample rows. */
  schemaSummary: string;
}

export interface GenerateTasksArgs {
  outputDir: OutputDir;
  mainConfig: LLMConfig;
  teacherModel: string;
  flavor: TaskGenFlavor;
  dataset: DatasetDescription;
  count: number;
  /** Output filename under tasks/. Defaults to "<flavor>-<timestamp>.jsonl". */
  outputName?: string;
}

export interface GeneratedTask {
  taskId: string;
  prompt: string;
  dataset: string;
  category?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
}

export interface GenerateTasksResult {
  outputFile: string;
  tasksWritten: number;
  tasks: GeneratedTask[];
}

const FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;

function extractJsonArray(raw: string): unknown {
  const fenced = FENCE_RE.exec(raw);
  const body = fenced ? fenced[1] : raw;
  return JSON.parse(body.trim());
}

function slugify(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export async function generateTasks(args: GenerateTasksArgs): Promise<GenerateTasksResult> {
  const systemPrompt = args.flavor === 'adversarial' ? adversarialPrompt : normalPrompt;
  const userPayload = [
    `# Dataset`,
    ``,
    `Path: ${args.dataset.path}`,
    ``,
    `Schema:`,
    args.dataset.schemaSummary,
    ``,
    `# Count`,
    ``,
    `Generate ${args.count} prompts.`,
  ].join('\n');

  const raw = await callTeacher(args.mainConfig, args.teacherModel, systemPrompt, userPayload);
  const parsed = extractJsonArray(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Teacher task-gen response was not a JSON array.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputName = args.outputName ?? `${args.flavor}-${stamp}.jsonl`;
  const appender = await openJsonlAppender(args.outputDir, `tasks/${outputName}`);

  const tasks: GeneratedTask[] = [];
  for (const item of parsed as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.prompt !== 'string') continue;
    const slug = slugify(o.prompt) || 'task';
    const taskId = `${args.flavor}-${stamp}-${tasks.length}-${slug}`;
    const task: GeneratedTask = {
      taskId,
      prompt: o.prompt,
      dataset: args.dataset.path,
    };
    if (typeof o.category === 'string') task.category = o.category;
    if (o.difficulty === 'easy' || o.difficulty === 'medium' || o.difficulty === 'hard') {
      task.difficulty = o.difficulty;
    }
    await appender.append(task);
    tasks.push(task);
  }

  return { outputFile: `tasks/${outputName}`, tasksWritten: tasks.length, tasks };
}
