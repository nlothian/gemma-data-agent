/**
 * Walks a workspace directory recursively and lists files that look like
 * data the agent could LoadData. Used to populate the dataset picker in
 * the task generator UI.
 */
import { type Workspace } from './workspace';

const DATA_EXTENSIONS = new Set([
  'csv', 'tsv', 'parquet', 'json', 'jsonl', 'xlsx',
]);

export interface DatasetEntry {
  /** Workspace-relative path (e.g. "datasets/iris.csv"). */
  path: string;
  /** File extension, lowercase, no dot. */
  ext: string;
  /** Size in bytes. */
  size: number;
}

const SKIP_DIRS = new Set(['output', 'node_modules', '.git', '.DS_Store']);

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: DatasetEntry[],
): Promise<void> {
  const iter = dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
  for await (const [name, handle] of iter) {
    if (SKIP_DIRS.has(name)) continue;
    if (handle.kind === 'directory') {
      await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`, out);
      continue;
    }
    const dot = name.lastIndexOf('.');
    if (dot < 0) continue;
    const ext = name.slice(dot + 1).toLowerCase();
    if (!DATA_EXTENSIONS.has(ext)) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    out.push({ path: `${prefix}${name}`, ext, size: file.size });
  }
}

export async function listDatasets(workspace: Workspace): Promise<DatasetEntry[]> {
  const out: DatasetEntry[] = [];
  await walk(workspace.root, '', out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
