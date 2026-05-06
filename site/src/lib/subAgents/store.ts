/**
 * In-memory store for SubAgent runs. Not persisted: clearing on page reload
 * and on "New conversation" is intentional. Mirrors the observer pattern of
 * `executionPanelStore` so React components can `useSyncExternalStore` it.
 */

import type { ChatMessage } from '../../types/chat';

export type SubAgentStatus = 'running' | 'done' | 'error' | 'aborted';

export interface SubAgentRun {
  id: string;
  label: string;
  status: SubAgentStatus;
  errorMessage?: string;
  messages: ChatMessage[];
  startedAt: number;
}

export interface SubAgentSnapshot {
  runs: SubAgentRun[];
  /** id of the run currently focused in the SubAgents tab. */
  activeRunId: string | null;
}

const INITIAL: SubAgentSnapshot = { runs: [], activeRunId: null };

let snapshot: SubAgentSnapshot = INITIAL;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function set(next: SubAgentSnapshot): void {
  snapshot = next;
  notify();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSnapshot(): SubAgentSnapshot {
  return snapshot;
}

export function getServerSnapshot(): SubAgentSnapshot {
  return INITIAL;
}

let nextId = 1;
function genRunId(): string {
  return `sub-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export function startRun(opts: { label: string }): string {
  const id = genRunId();
  const run: SubAgentRun = {
    id,
    label: opts.label,
    status: 'running',
    messages: [],
    startedAt: Date.now(),
  };
  set({ runs: [...snapshot.runs, run], activeRunId: id });
  return id;
}

export function appendMessage(runId: string, message: ChatMessage): void {
  const runs = snapshot.runs.map((r) =>
    r.id === runId ? { ...r, messages: [...r.messages, message] } : r,
  );
  set({ ...snapshot, runs });
}

export function updateLastAssistant(runId: string, delta: string): void {
  if (!delta) return;
  const runs = snapshot.runs.map((r) => {
    if (r.id !== runId) return r;
    const msgs = r.messages;
    if (msgs.length === 0) return r;
    const last = msgs[msgs.length - 1];
    if (last.role !== 'assistant') return r;
    const nextLast: ChatMessage = { ...last, content: last.content + delta };
    return { ...r, messages: [...msgs.slice(0, -1), nextLast] };
  });
  set({ ...snapshot, runs });
}

export function setStatus(
  runId: string,
  status: SubAgentStatus,
  errorMessage?: string,
): void {
  const runs = snapshot.runs.map((r) =>
    r.id === runId ? { ...r, status, errorMessage } : r,
  );
  set({ ...snapshot, runs });
}

export function setActiveRun(runId: string | null): void {
  if (snapshot.activeRunId === runId) return;
  set({ ...snapshot, activeRunId: runId });
}

export function clearAll(): void {
  set(INITIAL);
}
