/**
 * Step/Play/Pause gate for agent tool execution.
 *
 * Every tool dispatch passes through `awaitToolGate`. In `paused` mode the
 * gate suspends until the user presses Step (resolve, stay paused) or Play
 * (resolve, switch to running). In `running` mode the gate returns
 * immediately. Pressing Pause flips back to `paused` so the next call blocks.
 */

export type ToolDebuggerMode = 'paused' | 'running';

export interface PendingToolCall {
  toolName: string;
  input: unknown;
}

export interface ToolDebuggerSnapshot {
  mode: ToolDebuggerMode;
  pending: PendingToolCall | null;
}

type Listener = () => void;

interface PendingEntry {
  call: PendingToolCall;
  resolve: () => void;
  reject: (err: unknown) => void;
  detachAbort: () => void;
}

let snapshot: ToolDebuggerSnapshot = { mode: 'paused', pending: null };
const listeners = new Set<Listener>();
let pendingEntry: PendingEntry | null = null;

function notify(): void {
  for (const fn of listeners) fn();
}

function setSnapshot(next: ToolDebuggerSnapshot): void {
  snapshot = next;
  notify();
}

export function getSnapshot(): ToolDebuggerSnapshot {
  return snapshot;
}

const SERVER_SNAPSHOT: ToolDebuggerSnapshot = { mode: 'paused', pending: null };

export function getServerSnapshot(): ToolDebuggerSnapshot {
  return SERVER_SNAPSHOT;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setMode(mode: ToolDebuggerMode): void {
  if (snapshot.mode === mode) return;
  setSnapshot({ ...snapshot, mode });
}

export function pause(): void {
  if (snapshot.mode === 'paused') return;
  setSnapshot({ ...snapshot, mode: 'paused' });
}

export function step(): void {
  const entry = pendingEntry;
  if (!entry) return;
  pendingEntry = null;
  entry.detachAbort();
  setSnapshot({ mode: 'paused', pending: null });
  entry.resolve();
}

export function play(): void {
  const entry = pendingEntry;
  if (entry) {
    pendingEntry = null;
    entry.detachAbort();
    setSnapshot({ mode: 'running', pending: null });
    entry.resolve();
    return;
  }
  setMode('running');
}

export function reset(): void {
  const entry = pendingEntry;
  if (entry) {
    pendingEntry = null;
    entry.detachAbort();
    const err = new DOMException('Tool gate aborted', 'AbortError');
    entry.reject(err);
  }
  setSnapshot({ mode: 'paused', pending: null });
}

export function awaitToolGate(
  toolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Tool gate aborted', 'AbortError'));
  }
  if (snapshot.mode === 'running') {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const call: PendingToolCall = { toolName, input };
    let onAbort: (() => void) | null = null;
    const detachAbort = (): void => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      onAbort = null;
    };

    pendingEntry = { call, resolve, reject, detachAbort };

    if (signal) {
      onAbort = () => {
        if (pendingEntry !== null && pendingEntry.resolve === resolve) {
          pendingEntry = null;
          setSnapshot({ ...snapshot, pending: null });
        }
        detachAbort();
        reject(new DOMException('Tool gate aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    setSnapshot({ ...snapshot, pending: call });
  });
}
