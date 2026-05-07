/**
 * Reducer for the ExplainerPanel's tabbed history.
 *
 * The panel keeps a bounded scrollback of the last MAX_ENTRIES tool-call
 * explanations. Each pending tool call from the debugger appends an entry
 * (deduped against the most recent one so loading→ready→step doesn't churn
 * tabs) and becomes the active tab. SUMMARY_* events are routed to the entry
 * by id so async summariser results land on the right tab even if the user
 * has switched away.
 */

import type { PendingToolCall } from './toolDebugger';
import type { LLMConfig } from '../types/llm';
import type { ChatMessage } from '../types/chat';
import { COMPACTION_TOOL_NAME } from './autoCompaction';
import { summariseCode, type SummaryLanguage } from './summariseCode';

export const MAX_ENTRIES = 10;

export type SummaryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; message: string };

export type ExplainerEntry =
  | { id: string; kind: 'paused-python'; code: string; summary: SummaryState }
  | { id: string; kind: 'paused-sql'; sql: string; summary: SummaryState }
  | { id: string; kind: 'paused-react'; code: string; summary: SummaryState }
  | { id: string; kind: 'paused-subagent'; prompt: string; summary: SummaryState }
  | { id: string; kind: 'paused-load'; url: string }
  | { id: string; kind: 'paused-compaction'; messages: ChatMessage[] };

export type LiveMode = 'running' | 'paused-no-pending' | 'pending';

export interface ExplainerHistoryState {
  entries: ExplainerEntry[];
  activeId: string | null;
  liveMode: LiveMode;
  // Monotonic counter for minting entry ids. Survives CLEAR_ALL so cleared
  // ids don't collide with future ones; reset by RESET.
  nextId: number;
}

export type ExplainerEvent =
  | { type: 'MODE_RUNNING' }
  | { type: 'MODE_PAUSED_NO_PENDING' }
  | { type: 'PENDING'; call: PendingToolCall }
  | { type: 'SUMMARY_LOADING'; entryId: string }
  | { type: 'SUMMARY_READY'; entryId: string; text: string }
  | { type: 'SUMMARY_ERROR'; entryId: string; message: string }
  | { type: 'SET_ACTIVE'; id: string }
  | { type: 'CLEAR_ALL' }
  | { type: 'RESET' };

export const initialState: ExplainerHistoryState = {
  entries: [],
  activeId: null,
  liveMode: 'paused-no-pending',
  nextId: 1,
};

function readString(input: unknown, field: string): string | null {
  if (input && typeof input === 'object' && field in input) {
    const v = (input as Record<string, unknown>)[field];
    if (typeof v === 'string') return v;
  }
  return null;
}

function readMessages(input: unknown): ChatMessage[] {
  if (input && typeof input === 'object' && 'messages' in input) {
    const v = (input as Record<string, unknown>).messages;
    if (Array.isArray(v)) return v as ChatMessage[];
  }
  return [];
}

/**
 * Build an entry from a pending tool call. The id is supplied by the reducer
 * so this stays a pure builder. Returns null for tool calls that don't
 * correspond to any explainer entry.
 */
function entryFromPending(call: PendingToolCall, id: string): ExplainerEntry | null {
  const { toolName, input } = call;
  if (toolName === 'RunPython')
    return { id, kind: 'paused-python', code: readString(input, 'code') ?? '', summary: { status: 'idle' } };
  if (toolName === 'RunSQL')
    return { id, kind: 'paused-sql', sql: readString(input, 'sql') ?? '', summary: { status: 'idle' } };
  if (toolName === 'RunReact')
    return { id, kind: 'paused-react', code: readString(input, 'code') ?? '', summary: { status: 'idle' } };
  if (toolName === 'RunSubAgent')
    return { id, kind: 'paused-subagent', prompt: readString(input, 'prompt') ?? '', summary: { status: 'idle' } };
  if (toolName === 'LoadData')
    return { id, kind: 'paused-load', url: readString(input, 'url') ?? '' };
  if (toolName === COMPACTION_TOOL_NAME)
    return { id, kind: 'paused-compaction', messages: readMessages(input) };
  return null;
}

/**
 * True when two entries describe the same pending tool call. Used to avoid
 * appending a duplicate tab when the debugger re-emits the same PENDING event
 * (e.g. across a summariser-induced re-render). Compaction entries are
 * compared by message-array length — re-emitting an identical compaction
 * payload is rare and the imperfect match is fine.
 */
function sameContent(a: ExplainerEntry, b: ExplainerEntry): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'paused-python':
      return a.code === (b as typeof a).code;
    case 'paused-sql':
      return a.sql === (b as typeof a).sql;
    case 'paused-react':
      return a.code === (b as typeof a).code;
    case 'paused-subagent':
      return a.prompt === (b as typeof a).prompt;
    case 'paused-load':
      return a.url === (b as typeof a).url;
    case 'paused-compaction':
      return a.messages.length === (b as typeof a).messages.length;
  }
}

function patchEntry(
  state: ExplainerHistoryState,
  entryId: string,
  patch: (e: ExplainerEntry) => ExplainerEntry,
): ExplainerHistoryState {
  const idx = state.entries.findIndex((e) => e.id === entryId);
  if (idx < 0) return state;
  const next = patch(state.entries[idx]);
  if (next === state.entries[idx]) return state;
  const entries = state.entries.slice();
  entries[idx] = next;
  return { ...state, entries };
}

function applySummary(
  state: ExplainerHistoryState,
  entryId: string,
  summary: SummaryState,
): ExplainerHistoryState {
  return patchEntry(state, entryId, (entry) => {
    if (
      entry.kind !== 'paused-python' &&
      entry.kind !== 'paused-sql' &&
      entry.kind !== 'paused-react' &&
      entry.kind !== 'paused-subagent'
    ) return entry;
    return { ...entry, summary };
  });
}

export function reduce(
  state: ExplainerHistoryState,
  event: ExplainerEvent,
): ExplainerHistoryState {
  switch (event.type) {
    case 'RESET':
      return initialState;

    case 'MODE_RUNNING':
      return state.liveMode === 'running' ? state : { ...state, liveMode: 'running' };

    case 'MODE_PAUSED_NO_PENDING':
      return state.liveMode === 'paused-no-pending'
        ? state
        : { ...state, liveMode: 'paused-no-pending' };

    case 'PENDING': {
      const id = `e${state.nextId}`;
      const candidate = entryFromPending(event.call, id);
      if (candidate === null) {
        // Unknown tool — record liveMode but don't add a tab.
        return state.liveMode === 'pending' ? state : { ...state, liveMode: 'pending' };
      }
      const newest = state.entries[state.entries.length - 1];
      if (newest && sameContent(newest, candidate)) {
        // Dedup against the most recent tab.
        return state.liveMode === 'pending' ? state : { ...state, liveMode: 'pending' };
      }
      const entries = [...state.entries, candidate];
      while (entries.length > MAX_ENTRIES) entries.shift();
      return {
        ...state,
        entries,
        activeId: candidate.id,
        liveMode: 'pending',
        nextId: state.nextId + 1,
      };
    }

    case 'SUMMARY_LOADING':
      return applySummary(state, event.entryId, { status: 'loading' });
    case 'SUMMARY_READY':
      return applySummary(state, event.entryId, { status: 'ready', text: event.text });
    case 'SUMMARY_ERROR':
      return applySummary(state, event.entryId, { status: 'error', message: event.message });

    case 'SET_ACTIVE': {
      if (state.activeId === event.id) return state;
      if (!state.entries.some((e) => e.id === event.id)) return state;
      return { ...state, activeId: event.id };
    }

    case 'CLEAR_ALL':
      if (state.entries.length === 0 && state.activeId === null) return state;
      return { ...state, entries: [], activeId: null };
  }
}

export function findEntry(
  state: ExplainerHistoryState,
  id: string | null,
): ExplainerEntry | null {
  if (id === null) return null;
  return state.entries.find((e) => e.id === id) ?? null;
}

/**
 * Orchestrates a single summarisation request and dispatches the matching
 * lifecycle events. Extracted from the component so we can unit-test the
 * dispatch sequence end-to-end (LOADING → READY / ERROR) without React.
 *
 * Events carry the entry id so a stale fetch resolving after the entry has
 * been evicted (or the user has cleared the history) is dropped by the
 * reducer's id lookup.
 */
export async function runSummarisation(params: {
  language: SummaryLanguage;
  code: string;
  entryId: string;
  config: LLMConfig;
  signal: AbortSignal;
  dispatch: (event: ExplainerEvent) => void;
}): Promise<void> {
  const { language, code, entryId, config, signal, dispatch } = params;
  dispatch({ type: 'SUMMARY_LOADING', entryId });
  try {
    const text = await summariseCode(language, code, config, signal);
    if (signal.aborted) return;
    dispatch({ type: 'SUMMARY_READY', entryId, text });
  } catch (err) {
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    dispatch({ type: 'SUMMARY_ERROR', entryId, message });
  }
}
