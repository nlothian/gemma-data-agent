import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * In-memory OPFS stand-in. `agentFs` only touches a small slice of the File
 * System Access API: getDirectoryHandle/getFileHandle with `{ create }`,
 * getFile().text(), and createWritable().write()/close(). Absent entries throw
 * a `NotFoundError` (by `.name`), which `tryReadTextFileAt` keys off of.
 */
class MemFile {
  data = '';
}

function notFound(name: string): Error {
  const err = new Error(`NotFound: ${name}`);
  (err as { name?: string }).name = 'NotFoundError';
  return err;
}

class MemDir {
  files = new Map<string, MemFile>();
  dirs = new Map<string, MemDir>();
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw notFound(name);
      d = new MemDir(name);
      this.dirs.set(name, d);
    }
    return d as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) throw notFound(name);
      f = new MemFile();
      this.files.set(name, f);
    }
    const node = f;
    return {
      kind: 'file',
      name,
      async getFile() {
        const text = node.data;
        return { text: async () => text } as unknown as File;
      },
      async createWritable() {
        return {
          async write(chunk: string) {
            node.data = chunk;
          },
          async close() {},
        } as unknown as FileSystemWritableFileStream;
      },
    } as unknown as FileSystemFileHandle;
  }
}

// One persistent root for the whole file so `agentFs`'s module-level
// scratchpad-handle cache stays valid; we clear its contents per test.
const memRoot = new MemDir('');
vi.stubGlobal('navigator', {
  storage: { getDirectory: async () => memRoot },
});

import {
  writeLinesToFile,
  tryReadTextFileAt,
  readTextFileAt,
} from './agentFs';

beforeEach(() => {
  const sp = memRoot.dirs.get('scratchpad');
  if (sp) {
    sp.files.clear();
    sp.dirs.clear();
  }
});

describe('writeLinesToFile — omit from/to', () => {
  it('creates the file when it does not exist', async () => {
    const res = await writeLinesToFile(
      '/scratchpad/a.txt',
      undefined,
      undefined,
      'hello',
    );
    expect(res).toEqual({ created: true, totalLinesAfter: 1 });
    expect(await readTextFileAt('/scratchpad/a.txt')).toBe('hello\n');
  });

  it('overwrites the whole file when it already exists (no error)', async () => {
    await writeLinesToFile(
      '/scratchpad/a.txt',
      undefined,
      undefined,
      'first\nsecond\nthird',
    );

    const res = await writeLinesToFile(
      '/scratchpad/a.txt',
      undefined,
      undefined,
      'brand new body',
    );

    expect(res).toEqual({ created: false, totalLinesAfter: 1 });
    expect(await readTextFileAt('/scratchpad/a.txt')).toBe('brand new body\n');
  });

  it('overwriting with empty content truncates the file', async () => {
    await writeLinesToFile('/scratchpad/a.txt', undefined, undefined, 'stuff');

    const res = await writeLinesToFile(
      '/scratchpad/a.txt',
      undefined,
      undefined,
      '',
    );

    expect(res).toEqual({ created: false, totalLinesAfter: 0 });
    expect(await readTextFileAt('/scratchpad/a.txt')).toBe('');
  });
});

describe('writeLinesToFile — explicit bounds still work', () => {
  it('replaces a line range without touching the rest', async () => {
    await writeLinesToFile(
      '/scratchpad/b.txt',
      undefined,
      undefined,
      'a\nb\nc',
    );

    const res = await writeLinesToFile('/scratchpad/b.txt', 2, 2, 'B');

    expect(res.created).toBe(false);
    expect(await readTextFileAt('/scratchpad/b.txt')).toBe('a\nB\nc\n');
  });

  it('rejects a one-sided bound', async () => {
    await expect(
      writeLinesToFile('/scratchpad/c.txt', 1, undefined, 'x'),
    ).rejects.toThrow(/Provide both `from` and `to`/);
  });

  it('rejects explicit bounds on a non-existent file', async () => {
    expect(await tryReadTextFileAt('/scratchpad/missing.txt')).toBeNull();
    await expect(
      writeLinesToFile('/scratchpad/missing.txt', 2, 3, 'x'),
    ).rejects.toThrow(/File does not exist\. Omit `from` and `to`/);
  });
});
