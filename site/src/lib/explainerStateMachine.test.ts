import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initialState,
  reduce,
  runSummarisation,
  findEntry,
  MAX_ENTRIES,
  type ExplainerEvent,
  type ExplainerHistoryState,
} from './explainerStateMachine';
import type { LLMConfig } from '../types/llm';

function pythonPending(code: string): ExplainerEvent {
  return { type: 'PENDING', call: { toolName: 'RunPython', input: { code } } };
}
function sqlPending(sql: string): ExplainerEvent {
  return { type: 'PENDING', call: { toolName: 'RunSQL', input: { sql } } };
}

describe('explainerStateMachine', () => {
  it('starts empty with paused-no-pending live mode', () => {
    expect(initialState).toEqual({
      entries: [],
      activeId: null,
      liveMode: 'paused-no-pending',
      nextId: 1,
    });
  });

  it('MODE_RUNNING sets liveMode without touching entries', () => {
    const seeded = reduce(initialState, pythonPending('x = 1'));
    const next = reduce(seeded, { type: 'MODE_RUNNING' });
    expect(next.liveMode).toBe('running');
    expect(next.entries).toBe(seeded.entries);
    expect(next.activeId).toBe(seeded.activeId);
  });

  it('MODE_RUNNING returns same reference when already running', () => {
    const running = reduce(initialState, { type: 'MODE_RUNNING' });
    expect(reduce(running, { type: 'MODE_RUNNING' })).toBe(running);
  });

  it('MODE_PAUSED_NO_PENDING does not clear entries', () => {
    const seeded = reduce(initialState, pythonPending('print(1)'));
    const next = reduce(seeded, { type: 'MODE_PAUSED_NO_PENDING' });
    expect(next.liveMode).toBe('paused-no-pending');
    expect(next.entries).toBe(seeded.entries);
    expect(next.activeId).toBe(seeded.activeId);
  });

  it('PENDING RunPython appends a tab and activates it', () => {
    const next = reduce(initialState, pythonPending('x = 1'));
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({
      kind: 'paused-python',
      code: 'x = 1',
      summary: { status: 'idle' },
    });
    expect(next.activeId).toBe(next.entries[0].id);
    expect(next.liveMode).toBe('pending');
  });

  it('PENDING RunSQL appends a paused-sql tab', () => {
    const next = reduce(initialState, sqlPending('SELECT 1'));
    expect(next.entries[0]).toMatchObject({ kind: 'paused-sql', sql: 'SELECT 1' });
  });

  it('PENDING RunReact appends a paused-react tab', () => {
    const next = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunReact', input: { code: 'export default () => <div/>' } },
    });
    expect(next.entries[0]).toMatchObject({
      kind: 'paused-react',
      code: 'export default () => <div/>',
    });
  });

  it('PENDING RunSubAgent appends a paused-subagent tab', () => {
    const next = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunSubAgent', input: { prompt: 'do thing' } },
    });
    expect(next.entries[0]).toMatchObject({ kind: 'paused-subagent', prompt: 'do thing' });
  });

  it('PENDING LoadData appends a paused-load tab', () => {
    const next = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'LoadData', input: { url: 'https://example.com/x.csv', table_name: 't' } },
    });
    expect(next.entries[0]).toMatchObject({ kind: 'paused-load', url: 'https://example.com/x.csv' });
  });

  it('PENDING with same code as newest tab does not append a duplicate', () => {
    const first = reduce(initialState, pythonPending('A'));
    const second = reduce(first, pythonPending('A'));
    expect(second.entries).toBe(first.entries);
    expect(second.activeId).toBe(first.activeId);
  });

  it('PENDING with different code appends a new tab and switches active', () => {
    const first = reduce(initialState, pythonPending('A'));
    const second = reduce(first, pythonPending('B'));
    expect(second.entries).toHaveLength(2);
    expect(second.entries[1]).toMatchObject({ kind: 'paused-python', code: 'B' });
    expect(second.activeId).toBe(second.entries[1].id);
  });

  it('PENDING with the same RunReact code returns the same entries reference', () => {
    const first = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunReact', input: { code: 'A' } },
    });
    const second = reduce(first, {
      type: 'PENDING',
      call: { toolName: 'RunReact', input: { code: 'A' } },
    });
    expect(second.entries).toBe(first.entries);
  });

  it('PENDING with unknown tool does not append a tab', () => {
    const seeded = reduce(initialState, pythonPending('A'));
    const next = reduce(seeded, {
      type: 'PENDING',
      call: { toolName: 'Mystery', input: {} },
    });
    expect(next.entries).toBe(seeded.entries);
    expect(next.liveMode).toBe('pending');
  });

  it('PENDING with malformed input coerces to empty string', () => {
    const next = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'RunPython', input: null },
    });
    expect(next.entries[0]).toMatchObject({
      kind: 'paused-python',
      code: '',
      summary: { status: 'idle' },
    });
  });

  it('caps history at MAX_ENTRIES, evicting oldest', () => {
    let s = initialState;
    for (let i = 0; i < MAX_ENTRIES + 3; i++) {
      s = reduce(s, pythonPending(`x = ${i}`));
    }
    expect(s.entries).toHaveLength(MAX_ENTRIES);
    // Oldest three were evicted; first remaining should be code 3.
    expect(s.entries[0]).toMatchObject({ code: 'x = 3' });
    expect(s.entries[s.entries.length - 1]).toMatchObject({ code: `x = ${MAX_ENTRIES + 2}` });
    expect(s.activeId).toBe(s.entries[s.entries.length - 1].id);
  });

  it('SUMMARY_LOADING patches the summary on the matching entry', () => {
    const seeded = reduce(initialState, pythonPending('print(1)'));
    const id = seeded.entries[0].id;
    const next = reduce(seeded, { type: 'SUMMARY_LOADING', entryId: id });
    expect(next.entries[0]).toMatchObject({ summary: { status: 'loading' } });
  });

  it('SUMMARY_READY patches a non-active entry by id', () => {
    let s: ExplainerHistoryState = reduce(initialState, pythonPending('A'));
    const firstId = s.entries[0].id;
    s = reduce(s, sqlPending('SELECT 1')); // active is now sql
    s = reduce(s, { type: 'SUMMARY_READY', entryId: firstId, text: 'prints A' });
    const py = s.entries.find((e) => e.id === firstId);
    expect(py).toMatchObject({ summary: { status: 'ready', text: 'prints A' } });
  });

  it('SUMMARY events with an unknown id are no-ops', () => {
    const seeded = reduce(initialState, pythonPending('A'));
    const next = reduce(seeded, { type: 'SUMMARY_READY', entryId: 'bogus', text: 't' });
    expect(next).toBe(seeded);
  });

  it('SUMMARY_ERROR records the message for the matching entry', () => {
    const seeded = reduce(initialState, sqlPending('SELECT 1'));
    const id = seeded.entries[0].id;
    const next = reduce(seeded, { type: 'SUMMARY_ERROR', entryId: id, message: 'boom' });
    expect(next.entries[0]).toMatchObject({ summary: { status: 'error', message: 'boom' } });
  });

  it('SUMMARY events on entries without a summary field are no-ops', () => {
    const seeded = reduce(initialState, {
      type: 'PENDING',
      call: { toolName: 'LoadData', input: { url: 'https://x', table_name: 't' } },
    });
    const id = seeded.entries[0].id;
    const next = reduce(seeded, { type: 'SUMMARY_READY', entryId: id, text: 'nope' });
    expect(next).toBe(seeded);
  });

  it('SET_ACTIVE switches the active tab when the id exists', () => {
    let s = reduce(initialState, pythonPending('A'));
    const firstId = s.entries[0].id;
    s = reduce(s, sqlPending('SELECT 1'));
    expect(s.activeId).not.toBe(firstId);
    const next = reduce(s, { type: 'SET_ACTIVE', id: firstId });
    expect(next.activeId).toBe(firstId);
  });

  it('SET_ACTIVE is a no-op when the id is unknown', () => {
    const s = reduce(initialState, pythonPending('A'));
    expect(reduce(s, { type: 'SET_ACTIVE', id: 'bogus' })).toBe(s);
  });

  it('CLEAR_ALL empties entries and activeId, preserving liveMode and nextId', () => {
    let s = reduce(initialState, pythonPending('A'));
    s = reduce(s, pythonPending('B'));
    s = reduce(s, { type: 'MODE_RUNNING' });
    const cleared = reduce(s, { type: 'CLEAR_ALL' });
    expect(cleared.entries).toEqual([]);
    expect(cleared.activeId).toBeNull();
    expect(cleared.liveMode).toBe('running');
    expect(cleared.nextId).toBe(s.nextId);
  });

  it('CLEAR_ALL on an already-empty history is a no-op', () => {
    expect(reduce(initialState, { type: 'CLEAR_ALL' })).toBe(initialState);
  });

  it('RESET returns to initial state', () => {
    let s = reduce(initialState, pythonPending('x'));
    s = reduce(s, sqlPending('SELECT 1'));
    expect(reduce(s, { type: 'RESET' })).toEqual(initialState);
  });

  it('findEntry returns the active entry, or null when no id matches', () => {
    let s = reduce(initialState, pythonPending('A'));
    const id = s.entries[0].id;
    expect(findEntry(s, id)).toBe(s.entries[0]);
    expect(findEntry(s, null)).toBeNull();
    expect(findEntry(s, 'bogus')).toBeNull();
    s = reduce(s, { type: 'CLEAR_ALL' });
    expect(findEntry(s, id)).toBeNull();
  });

  it('a full LOADING → READY sequence on the active entry lands a ready summary', () => {
    let s: ExplainerHistoryState = reduce(initialState, pythonPending('print(1)'));
    const id = s.entries[0].id;
    s = reduce(s, { type: 'SUMMARY_LOADING', entryId: id });
    s = reduce(s, { type: 'SUMMARY_READY', entryId: id, text: 'Prints one.' });
    expect(s.entries[0]).toMatchObject({
      kind: 'paused-python',
      summary: { status: 'ready', text: 'Prints one.' },
    });
  });
});

const ANTHROPIC_CONFIG: LLMConfig = {
  activeEndpoint: 'https://api.anthropic.com/v1',
  customEndpoints: [],
  apiKeys: { 'https://api.anthropic.com/v1': 'sk-test' },
  models: { 'https://api.anthropic.com/v1': 'claude-test' },
  thinkingEnabled: {},
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
      entryId: 'e1',
      config: ANTHROPIC_CONFIG,
      signal: ctrl.signal,
      dispatch: (e) => events.push(e),
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'SUMMARY_LOADING', entryId: 'e1' });
    expect(events[1]).toEqual({
      type: 'SUMMARY_READY',
      entryId: 'e1',
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
      entryId: 'e2',
      config: ANTHROPIC_CONFIG,
      signal: ctrl.signal,
      dispatch: (e) => events.push(e),
    });

    expect(events[0]).toEqual({ type: 'SUMMARY_LOADING', entryId: 'e2' });
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
      entryId: 'e3',
      config: ANTHROPIC_CONFIG,
      signal: ctrl.signal,
      dispatch: (e) => events.push(e),
    });

    expect(events).toEqual([{ type: 'SUMMARY_LOADING', entryId: 'e3' }]);
    ctrl.abort();
    resolveFetch(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'late' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await pending;

    expect(events).toHaveLength(1);
  });
});
