/**
 * Pure reducer that drives the ExplainerPanel.
 *
 * The panel reflects two upstream signals: the run/pause mode of the tool
 * debugger and, when paused, the tool call we are blocked on. Summarisation
 * for python/sql is requested asynchronously by the parent component; this
 * reducer just tracks its lifecycle.
 */

import type { PendingToolCall } from './toolDebugger';
import type { LLMConfig } from '../types/llm';
import { summariseCode, type SummaryLanguage } from './summariseCode';

export type SummaryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error'; message: string };

export type ExplainerState =
  | { kind: 'empty' }
  | { kind: 'running' }
  | { kind: 'paused-python'; code: string; summary: SummaryState }
  | { kind: 'paused-sql'; sql: string; summary: SummaryState }
  | { kind: 'paused-load'; url: string };

export type ExplainerEvent =
  | { type: 'MODE_RUNNING' }
  | { type: 'MODE_PAUSED_NO_PENDING' }
  | { type: 'PENDING'; call: PendingToolCall }
  | { type: 'SUMMARY_LOADING'; key: string }
  | { type: 'SUMMARY_READY'; key: string; text: string }
  | { type: 'SUMMARY_ERROR'; key: string; message: string }
  | { type: 'RESET' };

export const initialState: ExplainerState = { kind: 'empty' };

/**
 * A stable identifier for the code/sql currently being summarised. Summary
 * events carry the same key so a stale fetch resolving after the user has
 * stepped past the call is ignored.
 */
export function summaryKey(state: ExplainerState): string | null {
  if (state.kind === 'paused-python') return `python:${state.code}`;
  if (state.kind === 'paused-sql') return `sql:${state.sql}`;
  return null;
}

function readString(input: unknown, field: string): string | null {
  if (input && typeof input === 'object' && field in input) {
    const v = (input as Record<string, unknown>)[field];
    if (typeof v === 'string') return v;
  }
  return null;
}

export function reduce(state: ExplainerState, event: ExplainerEvent): ExplainerState {
  switch (event.type) {
    case 'RESET':
      return initialState;

    case 'MODE_RUNNING':
      return state.kind === 'running' ? state : { kind: 'running' };

    case 'MODE_PAUSED_NO_PENDING':
      // Paused but nothing blocking: nothing to explain.
      return state.kind === 'empty' ? state : { kind: 'empty' };

    case 'PENDING': {
      const { toolName, input } = event.call;
      if (toolName === 'RunPython') {
        const code = readString(input, 'code') ?? '';
        if (state.kind === 'paused-python' && state.code === code) return state;
        return { kind: 'paused-python', code, summary: { status: 'idle' } };
      }
      if (toolName === 'RunSQL') {
        const sql = readString(input, 'sql') ?? '';
        if (state.kind === 'paused-sql' && state.sql === sql) return state;
        return { kind: 'paused-sql', sql, summary: { status: 'idle' } };
      }
      if (toolName === 'LoadData') {
        const url = readString(input, 'url') ?? '';
        if (state.kind === 'paused-load' && state.url === url) return state;
        return { kind: 'paused-load', url };
      }
      return { kind: 'empty' };
    }

    case 'SUMMARY_LOADING':
    case 'SUMMARY_READY':
    case 'SUMMARY_ERROR': {
      if (state.kind !== 'paused-python' && state.kind !== 'paused-sql') return state;
      if (summaryKey(state) !== event.key) return state;
      const next: SummaryState =
        event.type === 'SUMMARY_LOADING'
          ? { status: 'loading' }
          : event.type === 'SUMMARY_READY'
            ? { status: 'ready', text: event.text }
            : { status: 'error', message: event.message };
      return { ...state, summary: next };
    }
  }
}

/**
 * Orchestrates a single summarisation request and dispatches the matching
 * lifecycle events. Extracted from the component so we can unit-test the
 * dispatch sequence end-to-end (LOADING → READY / ERROR) without React.
 *
 * The dispatched events all carry the same `key` so that if the user steps
 * past this tool call before the request resolves, the reducer will drop the
 * stale result.
 */
export async function runSummarisation(params: {
  language: SummaryLanguage;
  code: string;
  key: string;
  config: LLMConfig;
  signal: AbortSignal;
  dispatch: (event: ExplainerEvent) => void;
}): Promise<void> {
  const { language, code, key, config, signal, dispatch } = params;
  dispatch({ type: 'SUMMARY_LOADING', key });
  try {
    const text = await summariseCode(language, code, config, signal);
    if (signal.aborted) return;
    dispatch({ type: 'SUMMARY_READY', key, text });
  } catch (err) {
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    dispatch({ type: 'SUMMARY_ERROR', key, message });
  }
}
