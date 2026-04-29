import { describe, expect, it } from 'vitest';
import {
  initialState,
  reduce,
  summaryKey,
  type ExplainerState,
} from './explainerStateMachine';

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
