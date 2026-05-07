/**
 * Pub-sub for which file the Sourcecode overlay should display in
 * file-viewer mode. The overlay reads this via `useSyncExternalStore`; both
 * the manual flow (search results list) and the explainer flow
 * (HighlightSourcecode tool, @sourcecode markdown links) drive it through
 * `setOpenFile` / `clearOpenFile`.
 */

interface OpenFileMatch {
  kind: 'match';
  path: string;
  /** 1-based line of the search match. */
  line: number;
  /** 0-based char offsets inside `line`. */
  matchStart: number;
  matchEnd: number;
}

interface OpenFileRange {
  kind: 'range';
  path: string;
  /** 1-based first line of the highlighted range. */
  startLine: number;
  /** 1-based last line of the highlighted range (inclusive). */
  endLine: number;
}

export type OpenFileTarget = OpenFileMatch | OpenFileRange;

let target: OpenFileTarget | null = null;
const listeners = new Set<() => void>();

export function getOpenFile(): OpenFileTarget | null {
  return target;
}

export function getServerOpenFile(): OpenFileTarget | null {
  return null;
}

export function subscribeOpenFile(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function isSameTarget(a: OpenFileTarget | null, b: OpenFileTarget | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.path !== b.path) return false;
  if (a.kind === 'match' && b.kind === 'match') {
    return a.line === b.line && a.matchStart === b.matchStart && a.matchEnd === b.matchEnd;
  }
  if (a.kind === 'range' && b.kind === 'range') {
    return a.startLine === b.startLine && a.endLine === b.endLine;
  }
  return false;
}

export function setOpenFile(next: OpenFileTarget): void {
  if (isSameTarget(target, next)) return;
  target = next;
  emit();
}

export function clearOpenFile(): void {
  if (target === null) return;
  target = null;
  emit();
}
