import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initialState,
  reduce,
  runSummarisation,
  summaryKey,
  type ExplainerEvent,
  type ExplainerState,
} from './explainerStateMachine';
import type { LLMConfig } from '../types/llm';

describe('explainerStateMachine', () => {
  it('starts empty', () => {
    expect(initialState).toEqual({ kind: 'empty' });
  });

  it('MODE_RUNNING → running', () => {
    const next = reduce(initialState, { type: 'MODE_RUNNING' });
    expect(next).toEqual({ kind: 'running' });
  });

  it('MODE_RUNNING returns same reference when already running', () => {
    const running: ExplainerState = { kind: 'running' };
    expect(reduce(running, { type: 'MODE_RUNNING' })).toBe(running);
  });

  it('MODE_PAUSED_NO_PENDING returns to empty from running', () => {
    const next = reduce({ kind: 'running' }, { type: 'MODE_PAUSED_NO_PENDING' });
    expect(next).toEqual({ kind: 'empty' });
  });

  it('MODE_PAUSED_NO_PENDING clears a stale paused-python state', () => {
    const stale: ExplainerState = {
      kind: 'paused-python',
      code: 'print(1)',
      summary: { status: 'ready', text: 'prints one' },
    };
    expect(reduce(stale, { type: 'MODE_PAUSED_NO_PENDING' })).toEqual({ kind: 'empty' });
  });

  it('PENDING RunPython → paused-python with idle summary', () => {
    const next = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: { code: 'x = 1' } },
    });
    expect(next).toEqual({
      kind: 'paused-python',
      code: 'x = 1',
      summary: { status: 'idle' },
    });
  });

  it('PENDING RunSQL → paused-sql with idle summary', () => {
    const next = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunSQL', input: { sql: 'SELECT 1' } },
    });
    expect(next).toEqual({
      kind: 'paused-sql',
      sql: 'SELECT 1',
      summary: { status: 'idle' },
    });
  });

  it('PENDING LoadData → paused-load with the URL', () => {
    const next = reduce(initialState, {
      type: 'PENDING',
      call: {
        toolName: 'LoadData',
        input: { url: 'https://example.com/x.csv', table_name: 't' },
      },
    });
    expect(next).toEqual({ kind: 'paused-load', url: 'https://example.com/x.csv' });
  });

  it('PENDING with unknown tool falls back to empty', () => {
    const next = reduce({ kind: 'running' }, {
      type: 'PENDING',
      call: { toolName: 'Mystery', input: {} },
    });
    expect(next).toEqual({ kind: 'empty' });
  });

  it('PENDING with malformed input coerces to empty string', () => {
    const next = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: null },
    });
    expect(next).toEqual({
      kind: 'paused-python',
      code: '',
      summary: { status: 'idle' },
    });
  });

  it('PENDING with the same RunPython code returns the same state reference', () => {
    const first = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: { code: 'x = 1' } },
    });
    const second = reduce(first, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: { code: 'x = 1' } },
    });
    expect(second).toBe(first);
  });

  it('SUMMARY_LOADING transitions a matching paused-python state', () => {
    const paused = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: { code: 'print(1)' } },
    });
    const key = summaryKey(paused)!;
    const next = reduce(paused, { type: 'SUMMARY_LOADING', key });
    expect(next).toMatchObject({
      kind: 'paused-python',
      summary: { status: 'loading' },
    });
  });

  it('SUMMARY_READY only applies if the key matches the current state', () => {
    const paused = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: { code: 'a' } },
    });
    const stale = reduce(paused, {
      type: 'SUMMARY_READY',
      key: 'python:b',
      text: 'stale',
    });
    expect(stale).toBe(paused);

    const fresh = reduce(paused, {
      type: 'SUMMARY_READY',
      key: summaryKey(paused)!,
      text: 'fresh',
    });
    expect(fresh).toMatchObject({
      kind: 'paused-python',
      summary: { status: 'ready', text: 'fresh' },
    });
  });

  it('SUMMARY_ERROR records the message for the matching state', () => {
    const paused = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunSQL', input: { sql: 'SELECT 1' } },
    });
    const next = reduce(paused, {
      type: 'SUMMARY_ERROR',
      key: summaryKey(paused)!,
      message: 'boom',
    });
    expect(next).toMatchObject({
      kind: 'paused-sql',
      summary: { status: 'error', message: 'boom' },
    });
  });

  it('SUMMARY events are no-ops outside python/sql paused states', () => {
    const running: ExplainerState = { kind: 'running' };
    expect(
      reduce(running, { type: 'SUMMARY_READY', key: 'python:x', text: 't' }),
    ).toBe(running);
    const load: ExplainerState = { kind: 'paused-load', url: 'https://x' };
    expect(
      reduce(load, { type: 'SUMMARY_LOADING', key: 'python:x' }),
    ).toBe(load);
  });

  it('summaryKey returns a stable identifier per code/sql', () => {
    const py: ExplainerState = {
      kind: 'paused-python',
      code: 'a',
      summary: { status: 'idle' },
    };
    const sql: ExplainerState = {
      kind: 'paused-sql',
      sql: 'a',
      summary: { status: 'idle' },
    };
    expect(summaryKey(py)).toBe('python:a');
    expect(summaryKey(sql)).toBe('sql:a');
    expect(summaryKey({ kind: 'empty' })).toBe(null);
    expect(summaryKey({ kind: 'running' })).toBe(null);
    expect(summaryKey({ kind: 'paused-load', url: 'https://x' })).toBe(null);
  });

  it('a full LOADING → READY sequence applied to a paused-python state lands a ready summary', () => {
    let s: ExplainerState = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: { code: 'print(1)' } },
    });
    const k = summaryKey(s)!;
    s = reduce(s, { type: 'SUMMARY_LOADING', key: k });
    s = reduce(s, { type: 'SUMMARY_READY', key: k, text: 'Prints one.' });
    expect(s).toMatchObject({
      kind: 'paused-python',
      summary: { status: 'ready', text: 'Prints one.' },
    });
  });

  it('RESET returns to initial state', () => {
    const paused = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: { code: 'x' } },
    });
    expect(reduce(paused, { type: 'RESET' })).toEqual(initialState);
  });

  it('switching tools resets summary lifecycle', () => {
    const py = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: { code: 'a' } },
    });
    const loading = reduce(py, { type: 'SUMMARY_LOADING', key: summaryKey(py)! });
    const sql = reduce(loading, {
      type: 'PENDING',
      call: { toolName: 'RunSQL', input: { sql: 'SELECT 1' } },
    });
    expect(sql).toEqual({
      kind: 'paused-sql',
      sql: 'SELECT 1',
      summary: { status: 'idle' },
    });
  });
});

const ANTHROPIC_CONFIG: LLMConfig = {
  activeEndpoint: 'https://api.anthropic.com/v1',
  customEndpoints: [],
  apiKeys: { 'https://api.anthropic.com/v1': 'sk-test' },
  models: { 'https://api.anthropic.com/v1': 'claude-test' },
};

describe('runSummarisation orchestration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchOnce(payload: unknown): void {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  it('dispatches LOADING and then READY when the summariser resolves', async () => {
    mockFetchOnce({ content: [{ type: 'text', text: 'It prints one.' }] });
    const events: ExplainerEvent[] = [];
    const ctrl = new AbortController();

    await runSummarisation({
      language: 'python',
      code: 'print(1)',
      key: 'python:print(1)',
      config: ANTHROPIC_CONFIG,
      signal: ctrl.signal,
      dispatch: (e) => events.push(e),
    });

    // Regression: previously the component aborted its own request when the
    // LOADING dispatch caused state to change, so READY was never reached.
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'SUMMARY_LOADING', key: 'python:print(1)' });
    expect(events[1]).toEqual({
      type: 'SUMMARY_READY',
      key: 'python:print(1)',
      text: 'It prints one.',
    });
  });

  it('dispatches ERROR when the summariser rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('boom', { status: 500 }),
    );
    const events: ExplainerEvent[] = [];
    const ctrl = new AbortController();

    await runSummarisation({
      language: 'sql',
      code: 'SELECT 1',
      key: 'sql:SELECT 1',
      config: ANTHROPIC_CONFIG,
      signal: ctrl.signal,
      dispatch: (e) => events.push(e),
    });

    expect(events[0]).toEqual({ type: 'SUMMARY_LOADING', key: 'sql:SELECT 1' });
    expect(events[1]?.type).toBe('SUMMARY_ERROR');
  });

  it('does not dispatch READY when the signal is aborted before resolution', async () => {
    let resolveFetch!: (r: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () => new Promise((res) => {
        resolveFetch = res;
      }),
    );
    const events: ExplainerEvent[] = [];
    const ctrl = new AbortController();

    const pending = runSummarisation({
      language: 'python',
      code: 'x = 1',
      key: 'python:x = 1',
      config: ANTHROPIC_CONFIG,
      signal: ctrl.signal,
      dispatch: (e) => events.push(e),
    });

    expect(events).toEqual([{ type: 'SUMMARY_LOADING', key: 'python:x = 1' }]);
    ctrl.abort();
    resolveFetch(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'late' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await pending;

    // Only the LOADING event should be in the queue — the late READY is dropped.
    expect(events).toHaveLength(1);
  });
});
