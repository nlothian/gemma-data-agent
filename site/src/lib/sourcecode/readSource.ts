/**
 * Read a source file from the OPFS sourcecode mirror.
 *
 * The sourcecode-vite-plugin bundles `site/src/**` (and a few root paths) into
 * a zip at build time; the sync worker unzips it into OPFS at
 * `<OPFS_ROOT_DIR>/<OPFS_FILES_DIR>/<path>`. This helper walks that tree and
 * returns the file contents as text.
 *
 * Both `SourcecodeFileViewer` (manual user flow) and the explainer's
 * `ReadLines` tool use this — call `ensureSourcecodeReady()` first if you're
 * not certain the OPFS mirror has been populated.
 */

import { OPFS_ROOT_DIR, OPFS_FILES_DIR } from './types';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Validate and split a sourcecode-relative path into safe segments.
 *
 * Defence-in-depth: while the OPFS APIs themselves reject `..` and similar,
 * we hard-fail before the walk so a bad path can never participate in the
 * traversal logic at all. The bundled mirror only contains alphanumeric +
 * `.-_` filenames (see the build glob in `sourcecodeVitePlugin`), so the
 * allowlist is tight enough to be a real defence without false negatives.
 */
export function validatePathSegments(path: string): string[] {
  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(`readSourceFile: invalid path "${path}"`);
  }
  for (const seg of segments) {
    if (
      seg === '.' ||
      seg === '..' ||
      seg.startsWith('.') ||
      seg.includes('\\') ||
      seg.includes('\0') ||
      !SAFE_SEGMENT.test(seg)
    ) {
      throw new Error(`readSourceFile: invalid path "${path}"`);
    }
  }
  return segments;
}

export async function readSourceFile(path: string): Promise<string> {
  const segments = validatePathSegments(path);
  const root = await navigator.storage.getDirectory();
  const scRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR);
  const filesRoot = await scRoot.getDirectoryHandle(OPFS_FILES_DIR);
  let dir: FileSystemDirectoryHandle = filesRoot;
  for (let i = 0; i < segments.length - 1; i++) {
    dir = await dir.getDirectoryHandle(segments[i]);
  }
  const fileHandle = await dir.getFileHandle(segments[segments.length - 1]);
  const blob = await fileHandle.getFile();
  return await blob.text();
}
