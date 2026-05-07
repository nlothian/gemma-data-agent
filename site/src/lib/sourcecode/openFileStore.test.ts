import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

async function load() {
  return await import('./openFileStore');
}

describe('openFileStore', () => {
  it('setOpenFile({kind:"match",...}) notifies subscribers exactly once on first set', async () => {
    const { setOpenFile, subscribe } = await load();
    const listener = vi.fn();
    subscribe(listener);
    setOpenFile({
      kind: 'match',
      path: 'a.ts',
      line: 1,
      matchStart: 0,
      matchEnd: 4,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setOpenFile with deeply-equal match payload is a no-op', async () => {
    const { setOpenFile, subscribe } = await load();
    setOpenFile({
      kind: 'match',
      path: 'a.ts',
      line: 1,
      matchStart: 0,
      matchEnd: 4,
    });
    const listener = vi.fn();
    subscribe(listener);
    setOpenFile({
      kind: 'match',
      path: 'a.ts',
      line: 1,
      matchStart: 0,
      matchEnd: 4,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('setOpenFile with deeply-equal range payload is a no-op', async () => {
    const { setOpenFile, subscribe } = await load();
    setOpenFile({
      kind: 'range',
      path: 'a.ts',
      startLine: 10,
      endLine: 20,
    });
    const listener = vi.fn();
    subscribe(listener);
    setOpenFile({
      kind: 'range',
      path: 'a.ts',
      startLine: 10,
      endLine: 20,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it('switching kind from match to range always notifies', async () => {
    const { setOpenFile, subscribe } = await load();
    setOpenFile({
      kind: 'match',
      path: 'a.ts',
      line: 1,
      matchStart: 0,
      matchEnd: 4,
    });
    const listener = vi.fn();
    subscribe(listener);
    setOpenFile({
      kind: 'range',
      path: 'a.ts',
      startLine: 1,
      endLine: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('switching kind from range to match always notifies', async () => {
    const { setOpenFile, subscribe } = await load();
    setOpenFile({
      kind: 'range',
      path: 'a.ts',
      startLine: 1,
      endLine: 1,
    });
    const listener = vi.fn();
    subscribe(listener);
    setOpenFile({
      kind: 'match',
      path: 'a.ts',
      line: 1,
      matchStart: 0,
      matchEnd: 4,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clearOpenFile is a no-op when state is already null', async () => {
    const { clearOpenFile, subscribe } = await load();
    const listener = vi.fn();
    subscribe(listener);
    clearOpenFile();
    expect(listener).not.toHaveBeenCalled();
  });

  it('clearOpenFile notifies when state is non-null', async () => {
    const { setOpenFile, clearOpenFile, subscribe } = await load();
    setOpenFile({
      kind: 'match',
      path: 'a.ts',
      line: 1,
      matchStart: 0,
      matchEnd: 4,
    });
    const listener = vi.fn();
    subscribe(listener);
    clearOpenFile();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe returns a working unsubscribe', async () => {
    const { setOpenFile, subscribe } = await load();
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    setOpenFile({
      kind: 'match',
      path: 'a.ts',
      line: 1,
      matchStart: 0,
      matchEnd: 4,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setOpenFile({
      kind: 'match',
      path: 'b.ts',
      line: 2,
      matchStart: 0,
      matchEnd: 4,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('getServerSnapshot returns null', async () => {
    const { getServerSnapshot, setOpenFile } = await load();
    setOpenFile({
      kind: 'match',
      path: 'a.ts',
      line: 1,
      matchStart: 0,
      matchEnd: 4,
    });
    expect(getServerSnapshot()).toBeNull();
  });
});
