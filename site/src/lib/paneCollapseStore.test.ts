import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStorage {
  store: Map<string, string>;
  setItem(k: string, v: string): void;
  getItem(k: string): string | null;
  removeItem(k: string): void;
  clear(): void;
}

function makeFakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  return {
    store,
    setItem: (k, v) => void store.set(k, v),
    getItem: (k) => store.get(k) ?? null,
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  };
}

let storage: FakeStorage;

beforeEach(() => {
  storage = makeFakeStorage();
  vi.stubGlobal('window', {
    localStorage: storage,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load() {
  return await import('./paneCollapseStore');
}

describe('paneCollapseStore — persisted state', () => {
  it('defaults to both expanded when no storage exists', async () => {
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual({ exec: false, explainer: false });
  });

  it('hydrates from localStorage on first read', async () => {
    storage.setItem(
      'haw.paneCollapse.v1',
      JSON.stringify({ exec: true, explainer: false }),
    );
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual({ exec: true, explainer: false });
  });

  it('falls back to defaults when storage value is malformed', async () => {
    storage.setItem('haw.paneCollapse.v1', 'not-json');
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual({ exec: false, explainer: false });
  });

  it('falls back to defaults when storage value has wrong shape', async () => {
    storage.setItem(
      'haw.paneCollapse.v1',
      JSON.stringify({ exec: 'yes', explainer: 1 }),
    );
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual({ exec: false, explainer: false });
  });

  it('setExecCollapsed updates persisted state and writes localStorage', async () => {
    const { setExecCollapsed, __forTests } = await load();
    setExecCollapsed(true);
    expect(__forTests.getRawSnapshot()).toEqual({ exec: true, explainer: false });
    expect(JSON.parse(storage.getItem('haw.paneCollapse.v1')!)).toEqual({
      exec: true,
      explainer: false,
    });
  });

  it('setExplainerCollapsed updates state independently of exec', async () => {
    const { setExecCollapsed, setExplainerCollapsed, __forTests } = await load();
    setExecCollapsed(true);
    setExplainerCollapsed(true);
    expect(__forTests.getRawSnapshot()).toEqual({ exec: true, explainer: true });
  });

  it('is a no-op when value is unchanged (no notify, no write)', async () => {
    const { setExecCollapsed, __forTests } = await load();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    const listener = vi.fn();
    __forTests.subscribe(listener);
    setExecCollapsed(false);
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on actual change', async () => {
    const { setExecCollapsed, __forTests } = await load();
    const listener = vi.fn();
    __forTests.subscribe(listener);
    setExecCollapsed(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('paneCollapseStore — force-expand stack', () => {
  it('overlays effective snapshot to both-expanded while reasons active', async () => {
    const {
      pushForceExpand,
      setExecCollapsed,
      setExplainerCollapsed,
      __forTests,
    } = await load();
    setExecCollapsed(true);
    setExplainerCollapsed(true);
    expect(__forTests.getRawSnapshot()).toEqual({ exec: true, explainer: true });
    expect(__forTests.getEffectiveSnapshot()).toEqual({ exec: true, explainer: true });

    pushForceExpand('tour');
    expect(__forTests.getRawSnapshot()).toEqual({ exec: true, explainer: true });
    expect(__forTests.getEffectiveSnapshot()).toEqual({ exec: false, explainer: false });
  });

  it('restores effective snapshot when stack drains', async () => {
    const { pushForceExpand, popForceExpand, setExecCollapsed, __forTests } =
      await load();
    setExecCollapsed(true);
    pushForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual({ exec: false, explainer: false });
    popForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual({ exec: true, explainer: false });
  });

  it('treats push of an already-active reason as a no-op', async () => {
    const { pushForceExpand, popForceExpand, setExecCollapsed, __forTests } =
      await load();
    setExecCollapsed(true);
    pushForceExpand('tour');
    pushForceExpand('tour');
    popForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual({ exec: true, explainer: false });
  });

  it('keeps overlay active while any reason remains', async () => {
    const { pushForceExpand, popForceExpand, setExecCollapsed, __forTests } =
      await load();
    setExecCollapsed(true);
    pushForceExpand('tour');
    pushForceExpand('pause');
    popForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual({ exec: false, explainer: false });
    popForceExpand('pause');
    expect(__forTests.getEffectiveSnapshot()).toEqual({ exec: true, explainer: false });
  });

  it('ignores pop of a reason that was never pushed', async () => {
    const { popForceExpand, setExecCollapsed, __forTests } = await load();
    setExecCollapsed(true);
    popForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual({ exec: true, explainer: false });
  });
});

describe('paneCollapseStore — pending focus', () => {
  it('sets focus target to rail tab when collapsing exec', async () => {
    const { setExecCollapsed, consumePendingFocus } = await load();
    setExecCollapsed(true);
    expect(consumePendingFocus('rail-exec-tab')).toBe(true);
    expect(consumePendingFocus('rail-exec-tab')).toBe(false);
  });

  it('sets focus target to collapse button when expanding exec', async () => {
    const { setExecCollapsed, consumePendingFocus } = await load();
    setExecCollapsed(true);
    consumePendingFocus('rail-exec-tab');
    setExecCollapsed(false);
    expect(consumePendingFocus('exec-collapse-btn')).toBe(true);
  });

  it('sets focus target when collapsing explainer', async () => {
    const { setExplainerCollapsed, consumePendingFocus } = await load();
    setExplainerCollapsed(true);
    expect(consumePendingFocus('rail-explainer-tab')).toBe(true);
  });

  it('returns false for non-matching target without clearing', async () => {
    const { setExecCollapsed, consumePendingFocus } = await load();
    setExecCollapsed(true);
    expect(consumePendingFocus('rail-explainer-tab')).toBe(false);
    expect(consumePendingFocus('rail-exec-tab')).toBe(true);
  });

  it('does not set a focus target on no-op writes', async () => {
    const { setExecCollapsed, consumePendingFocus } = await load();
    setExecCollapsed(false);
    expect(consumePendingFocus('exec-collapse-btn')).toBe(false);
    expect(consumePendingFocus('rail-exec-tab')).toBe(false);
  });
});
