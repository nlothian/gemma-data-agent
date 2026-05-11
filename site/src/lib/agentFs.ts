/**
 * Virtual filesystem for the agent's `ListFiles`/`ReadLines`/`WriteLines`
 * tools and for path-based `RunPython`/`RunSQL`/`RunReact`. Two roots:
 *
 *   /input      — the user's sandbox directory (FS Access API). Read-only;
 *                 the handle is opened in `mode: 'read'` in `sandboxStore`.
 *   /scratchpad — an OPFS directory. Read/write. Created on first use.
 */

import {
  getCurrentDirectoryHandle,
  SUPPORTED_EXTS as SANDBOX_SUPPORTED_EXTS,
} from './sandboxStore';

export type AgentFsRoot = 'input' | 'scratchpad';

export interface ResolvedVirtualPath {
  root: AgentFsRoot;
  segments: string[];
}

const SCRATCHPAD_TEXT_EXTS: ReadonlySet<string> = new Set([
  'txt', 'md', 'markdown', 'mdx', 'html', 'htm',
  'json', 'yaml', 'yml', 'csv', 'tsv', 'xml',
  'css', 'js', 'ts', 'tsx', 'jsx',
  'py', 'sql', 'rs', 'go', 'sh', 'toml', 'ini', 'log',
]);

const INPUT_LISTING_EXTS: ReadonlySet<string> = new Set(SANDBOX_SUPPORTED_EXTS);

export function resolveVirtualPath(virtualPath: string): ResolvedVirtualPath {
  if (typeof virtualPath !== 'string' || !virtualPath.startsWith('/')) {
    throw new Error(
      `Path must start with /input or /scratchpad (got ${JSON.stringify(virtualPath)})`,
    );
  }
  const parts = virtualPath.split('/').filter((p) => p !== '');
  if (parts.length === 0) {
    throw new Error('Path must start with /input or /scratchpad');
  }
  const head = parts[0];
  if (head !== 'input' && head !== 'scratchpad') {
    throw new Error(`Path root must be /input or /scratchpad (got /${head})`);
  }
  const segments = parts.slice(1);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error('Path segments "." and ".." are not allowed');
    }
  }
  return { root: head as AgentFsRoot, segments };
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function isListableForRoot(name: string, root: AgentFsRoot): boolean {
  const ext = extOf(name);
  if (root === 'input') return INPUT_LISTING_EXTS.has(ext);
  return SCRATCHPAD_TEXT_EXTS.has(ext);
}

async function getInputRootHandle(): Promise<FileSystemDirectoryHandle> {
  const handle = getCurrentDirectoryHandle();
  if (!handle) {
    throw new Error(
      'Input directory is not selected. Pick one in Settings → Sandbox.',
    );
  }
  return handle;
}

let scratchpadHandle: FileSystemDirectoryHandle | null = null;

async function getScratchpadRootHandle(): Promise<FileSystemDirectoryHandle> {
  if (scratchpadHandle) return scratchpadHandle;
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error('OPFS is unavailable in this environment.');
  }
  const root = await navigator.storage.getDirectory();
  scratchpadHandle = await root.getDirectoryHandle('scratchpad', { create: true });
  return scratchpadHandle;
}

async function getRootHandle(root: AgentFsRoot): Promise<FileSystemDirectoryHandle> {
  return root === 'input' ? getInputRootHandle() : getScratchpadRootHandle();
}

async function walkToDirectory(
  rootHandle: FileSystemDirectoryHandle,
  segments: string[],
  opts: { create: boolean },
): Promise<FileSystemDirectoryHandle> {
  let cur = rootHandle;
  for (const seg of segments) {
    cur = await cur.getDirectoryHandle(seg, { create: opts.create });
  }
  return cur;
}

export async function listFilesUnder(virtualPath: string): Promise<string[]> {
  const { root, segments } = resolveVirtualPath(virtualPath);
  const rootHandle = await getRootHandle(root);
  const startDir = await walkToDirectory(rootHandle, segments, { create: false });

  const out: string[] = [];
  const prefix = `/${root}${segments.length ? '/' + segments.join('/') : ''}`;

  const join = (rel: string): string => `${prefix}/${rel}`;

  async function recurse(
    dir: FileSystemDirectoryHandle,
    relParts: string[],
  ): Promise<void> {
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind === 'file') {
        if (!isListableForRoot(name, root)) continue;
        out.push(join([...relParts, name].join('/')));
      } else if (entry.kind === 'directory') {
        out.push(join([...relParts, name].join('/')) + '/');
        await recurse(entry as FileSystemDirectoryHandle, [...relParts, name]);
      }
    }
  }
  await recurse(startDir, []);
  out.sort();
  return out;
}

interface FileLocation {
  parent: FileSystemDirectoryHandle;
  fileName: string;
  root: AgentFsRoot;
}

async function locateFileForRead(virtualPath: string): Promise<FileLocation> {
  const { root, segments } = resolveVirtualPath(virtualPath);
  if (segments.length === 0) {
    throw new Error(`Path must include a filename (got /${root})`);
  }
  const fileName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);
  const rootHandle = await getRootHandle(root);
  const parent = await walkToDirectory(rootHandle, dirSegments, { create: false });
  return { parent, fileName, root };
}

async function locateFileForWrite(virtualPath: string): Promise<FileLocation> {
  const { root, segments } = resolveVirtualPath(virtualPath);
  if (root !== 'scratchpad') {
    throw new Error('Writes are only allowed under /scratchpad');
  }
  if (segments.length === 0) {
    throw new Error(`Path must include a filename (got /${root})`);
  }
  const fileName = segments[segments.length - 1];
  const dirSegments = segments.slice(0, -1);
  if (!SCRATCHPAD_TEXT_EXTS.has(extOf(fileName))) {
    throw new Error(
      `Only text files are supported under /scratchpad (extensions: ${[...SCRATCHPAD_TEXT_EXTS].join(', ')})`,
    );
  }
  const rootHandle = await getRootHandle(root);
  const parent = await walkToDirectory(rootHandle, dirSegments, { create: true });
  return { parent, fileName, root };
}

export async function readTextFileAt(virtualPath: string): Promise<string> {
  const { parent, fileName } = await locateFileForRead(virtualPath);
  const handle = await parent.getFileHandle(fileName, { create: false });
  const file = await handle.getFile();
  return await file.text();
}

export async function tryReadTextFileAt(
  virtualPath: string,
): Promise<string | null> {
  try {
    return await readTextFileAt(virtualPath);
  } catch (err) {
    const name = (err as { name?: string } | null)?.name ?? '';
    if (name === 'NotFoundError') return null;
    throw err;
  }
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

export async function readLinesFromFile(
  virtualPath: string,
  from: number,
  to: number,
): Promise<string> {
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    throw new Error('from and to must be integers');
  }
  if (from < 1) throw new Error('from must be >= 1');
  if (to < from) throw new Error('to must be >= from');

  const text = await readTextFileAt(virtualPath);
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = splitLines(body);

  const start = Math.min(from, lines.length + 1) - 1;
  const end = Math.min(to, lines.length);
  const selected = lines.slice(start, end);
  const totalDigits = String(lines.length).length || 1;

  const numbered = selected.map((line, i) => {
    const n = String(start + 1 + i).padStart(totalDigits, ' ');
    return `${n} | ${line}`;
  });

  const header = `# ${virtualPath} — lines ${start + 1}-${start + selected.length} of ${lines.length}`;
  if (selected.length === 0) {
    return `${header}\n(no lines in range)`;
  }
  return `${header}\n${numbered.join('\n')}`;
}

export interface WriteLinesResult {
  totalLinesAfter: number;
  created: boolean;
}

export async function writeLinesToFile(
  virtualPath: string,
  from: number | undefined,
  to: number | undefined,
  content: string,
): Promise<WriteLinesResult> {
  const { root } = resolveVirtualPath(virtualPath);
  if (root !== 'scratchpad') {
    throw new Error('WriteLines can only target paths under /scratchpad');
  }
  if (typeof content !== 'string') {
    throw new Error('content must be a string');
  }

  const fromOmitted = from === undefined;
  const toOmitted = to === undefined;
  if (fromOmitted !== toOmitted) {
    throw new Error('Provide both `from` and `to`, or omit both to create a new file.');
  }
  const bothOmitted = fromOmitted && toOmitted;
  if (!bothOmitted) {
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new Error('from and to must be integers');
    }
    if ((from as number) < 1) throw new Error('from must be >= 1');
    if ((to as number) < (from as number) - 1) {
      throw new Error('to must be >= from - 1 (use to=from-1 to insert without replacing)');
    }
  }

  const existing = await tryReadTextFileAt(virtualPath);
  const created = existing === null;

  if (bothOmitted) {
    if (!created) {
      throw new Error(
        `File ${virtualPath} already exists. Provide explicit \`from\`/\`to\` to edit it (ReadLines first to see line numbers).`,
      );
    }
    from = 1;
    to = 0;
  } else if (created && (from !== 1 || to !== 0)) {
    throw new Error(
      'File does not exist. Omit `from` and `to` to create it from `content`.',
    );
  }

  const text = existing ?? '';
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = splitLines(body);

  const fromN = from as number;
  const toN = to as number;
  if (fromN > lines.length + 1) {
    throw new Error(
      `from=${fromN} is past end of file (file has ${lines.length} lines; max from is ${lines.length + 1})`,
    );
  }
  const removeCount = Math.max(0, toN - fromN + 1);
  const insertLines = splitLines(content);

  const next = [
    ...lines.slice(0, fromN - 1),
    ...insertLines,
    ...lines.slice(fromN - 1 + removeCount),
  ];

  let outText = next.join('\n');
  if (outText !== '' && (trailingNewline || created)) {
    outText += '\n';
  }

  const { parent, fileName } = await locateFileForWrite(virtualPath);
  const handle = await parent.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(outText);
  } finally {
    await writable.close();
  }

  return { totalLinesAfter: next.length, created };
}

/**
 * Full-replace write convenience for the manual ExecutionPanel re-run. Always
 * targets /scratchpad; creates parent dirs and the file as needed.
 */
export async function writeFileAt(
  virtualPath: string,
  content: string,
): Promise<void> {
  const { parent, fileName } = await locateFileForWrite(virtualPath);
  const handle = await parent.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}
