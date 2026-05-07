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
  | { id: string; kind: 'paused-compaction'; messages: ChatMessage[] }
  | {
      id: string;
      kind: 'conversation';
      title: string;
      messages: ChatMessage[];
      draftInput: string;
      isStreaming: boolean;
      error?: string;
    };

export type ConversationEntry = Extract<ExplainerEntry, { kind: 'conversation' }>;

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
  | { type: 'RESET' }
  | { type: 'NEW_CONVERSATION' }
  | { type: 'CONVERSATION_SET_INPUT'; entryId: string; value: string }
  | {
      type: 'CONVERSATION_APPEND_USER';
      entryId: string;
      userMessage: ChatMessage;
      assistantMessageId: string;
    }
  | { type: 'CONVERSATION_STREAM_TOKEN'; entryId: string; delta: string }
  | { type: 'CONVERSATION_STREAM_DONE'; entryId: string }
  | { type: 'CONVERSATION_STREAM_ERROR'; entryId: string; message: string };

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
    case 'conversation':
      return false;
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

function patchConversation(
  state: ExplainerHistoryState,
  entryId: string,
  patch: (e: ConversationEntry) => ConversationEntry,
): ExplainerHistoryState {
  return patchEntry(state, entryId, (entry) => {
    if (entry.kind !== 'conversation') return entry;
    return patch(entry);
  });
}

/**
 * Trim the *existing* entry list so a new conversation entry can be
 * appended without exceeding MAX_ENTRIES. Eviction order:
 *   1. Oldest non-conversation entry.
 *   2. Otherwise, oldest non-streaming conversation.
 *   3. Otherwise (every existing entry is a streaming conversation),
 *      return unchanged — the caller appends anyway and the cap is
 *      exceeded by 1 rather than killing a live stream.
 *
 * Operates on `state.entries` only (before the new entry is appended) so
 * the freshly-minted non-streaming conversation can never match the
 * "oldest non-streaming conversation" rule and evict itself.
 */
function evictExistingForNewConversation(
  entries: ExplainerEntry[],
): ExplainerEntry[] {
  if (entries.length < MAX_ENTRIES) return entries;
  const idxNonConversation = entries.findIndex((e) => e.kind !== 'conversation');
  if (idxNonConversation >= 0) {
    const next = entries.slice();
    next.splice(idxNonConversation, 1);
    return next;
  }
  const idxIdleConversation = entries.findIndex(
    (e) => e.kind === 'conversation' && !e.isStreaming,
  );
  if (idxIdleConversation >= 0) {
    const next = entries.slice();
    next.splice(idxIdleConversation, 1);
    return next;
  }
  return entries;
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

    case 'NEW_CONVERSATION': {
      const id = `e${state.nextId}`;
      const entry: ExplainerEntry = {
        id,
        kind: 'conversation',
        title: `Live help ${state.nextId}`,
        messages: [],
        draftInput: '',
        isStreaming: false,
      };
      const entries = [...evictExistingForNewConversation(state.entries), entry];
      return {
        ...state,
        entries,
        activeId: id,
        nextId: state.nextId + 1,
      };
    }

    case 'CONVERSATION_SET_INPUT':
      return patchConversation(state, event.entryId, (entry) =>
        entry.draftInput === event.value ? entry : { ...entry, draftInput: event.value },
      );

    case 'CONVERSATION_APPEND_USER': {
      const assistantMessage: ChatMessage = {
        id: event.assistantMessageId,
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
      };
      return patchConversation(state, event.entryId, (entry) => ({
        ...entry,
        draftInput: '',
        messages: [...entry.messages, event.userMessage, assistantMessage],
        isStreaming: true,
        error: undefined,
      }));
    }

    case 'CONVERSATION_STREAM_TOKEN':
      return patchConversation(state, event.entryId, (entry) => {
        if (entry.messages.length === 0) return entry;
        const last = entry.messages[entry.messages.length - 1];
        if (last.role !== 'assistant') return entry;
        const messages = entry.messages.slice();
        messages[messages.length - 1] = { ...last, content: last.content + event.delta };
        return { ...entry, messages };
      });

    case 'CONVERSATION_STREAM_DONE':
      return patchConversation(state, event.entryId, (entry) =>
        entry.isStreaming ? { ...entry, isStreaming: false } : entry,
      );

    case 'CONVERSATION_STREAM_ERROR':
      return patchConversation(state, event.entryId, (entry) => ({
        ...entry,
        isStreaming: false,
        error: event.message,
      }));
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
