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

const BOTH_DEFAULT = { agents: 'default', explainer: 'default' } as const;

describe('paneCollapseStore — persisted state', () => {
  it('defaults to both default when no storage exists', async () => {
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual(BOTH_DEFAULT);
  });

  it('hydrates from localStorage on first read', async () => {
    storage.setItem(
      'haw.paneLayout.v2',
      JSON.stringify({ agents: 'minimized', explainer: 'default' }),
    );
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'default',
    });
  });

  it('falls back to defaults when storage value is malformed', async () => {
    storage.setItem('haw.paneLayout.v2', 'not-json');
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual(BOTH_DEFAULT);
  });

  it('falls back to defaults when storage value has wrong shape', async () => {
    storage.setItem(
      'haw.paneLayout.v2',
      JSON.stringify({ agents: 'yes', explainer: 1 }),
    );
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual(BOTH_DEFAULT);
  });

  it('normalizes invariant violations on hydrate', async () => {
    storage.setItem(
      'haw.paneLayout.v2',
      JSON.stringify({ agents: 'maximized', explainer: 'default' }),
    );
    const { __forTests } = await load();
    expect(__forTests.getRawSnapshot()).toEqual(BOTH_DEFAULT);
  });

  it('minimize updates persisted state and writes localStorage', async () => {
    const { minimize, __forTests } = await load();
    minimize('agents');
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'default',
    });
    expect(JSON.parse(storage.getItem('haw.paneLayout.v2')!)).toEqual({
      agents: 'minimized',
      explainer: 'default',
    });
  });

  it('minimize on each pane is independent', async () => {
    const { minimize, __forTests } = await load();
    minimize('agents');
    minimize('explainer');
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'minimized',
    });
  });

  it('is a no-op when value is unchanged (no notify, no write)', async () => {
    const { restore, __forTests } = await load();
    const setItemSpy = vi.spyOn(storage, 'setItem');
    const listener = vi.fn();
    __forTests.subscribe(listener);
    restore('agents');
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on actual change', async () => {
    const { minimize, __forTests } = await load();
    const listener = vi.fn();
    __forTests.subscribe(listener);
    minimize('agents');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('paneCollapseStore — invariant: maximize implies other minimized', () => {
  it('maximize sets the other pane to minimized', async () => {
    const { maximize, __forTests } = await load();
    maximize('agents');
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'maximized',
      explainer: 'minimized',
    });
  });

  it('maximize on the other pane swaps which one is minimized', async () => {
    const { maximize, __forTests } = await load();
    maximize('agents');
    maximize('explainer');
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'maximized',
    });
  });

  it('restoring a pane demotes a maximized neighbour to default', async () => {
    const { maximize, restore, __forTests } = await load();
    maximize('explainer');
    restore('agents');
    expect(__forTests.getRawSnapshot()).toEqual(BOTH_DEFAULT);
  });

  it('restoring from rail leaves a non-maximized neighbour alone', async () => {
    const { minimize, restore, __forTests } = await load();
    minimize('agents');
    restore('agents');
    expect(__forTests.getRawSnapshot()).toEqual(BOTH_DEFAULT);
  });

  it('minimizing the maximized pane leaves both panes minimized', async () => {
    const { maximize, minimize, __forTests } = await load();
    maximize('agents');
    minimize('agents');
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'minimized',
    });
  });
});

describe('paneCollapseStore — force-expand stack', () => {
  it('overlays effective snapshot to default while reasons active', async () => {
    const { pushForceExpand, minimize, __forTests } = await load();
    minimize('agents');
    minimize('explainer');
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'minimized',
    });
    expect(__forTests.getEffectiveSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'minimized',
    });

    pushForceExpand('tour');
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'minimized',
    });
    expect(__forTests.getEffectiveSnapshot()).toEqual(BOTH_DEFAULT);
  });

  it('restores effective snapshot when stack drains', async () => {
    const { pushForceExpand, popForceExpand, minimize, __forTests } =
      await load();
    minimize('agents');
    pushForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual(BOTH_DEFAULT);
    popForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'default',
    });
  });

  it('treats push of an already-active reason as a no-op', async () => {
    const { pushForceExpand, popForceExpand, minimize, __forTests } =
      await load();
    minimize('agents');
    pushForceExpand('tour');
    pushForceExpand('tour');
    popForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'default',
    });
  });

  it('keeps overlay active while any reason remains', async () => {
    const { pushForceExpand, popForceExpand, minimize, __forTests } =
      await load();
    minimize('agents');
    pushForceExpand('tour');
    pushForceExpand('pause');
    popForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual(BOTH_DEFAULT);
    popForceExpand('pause');
    expect(__forTests.getEffectiveSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'default',
    });
  });

  it('ignores pop of a reason that was never pushed', async () => {
    const { popForceExpand, minimize, __forTests } = await load();
    minimize('agents');
    popForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'default',
    });
  });

  it('per-pane release lets one pane minimize while the other stays forced', async () => {
    const { pushForceExpand, popForceExpand, minimize, __forTests } =
      await load();
    minimize('agents');
    minimize('explainer');
    pushForceExpand('tour');
    expect(__forTests.getEffectiveSnapshot()).toEqual(BOTH_DEFAULT);

    popForceExpand('tour', 'agents');
    expect(__forTests.getEffectiveSnapshot()).toEqual({
      agents: 'minimized',
      explainer: 'default',
    });

    pushForceExpand('tour', 'agents');
    popForceExpand('tour', 'explainer');
    expect(__forTests.getEffectiveSnapshot()).toEqual({
      agents: 'default',
      explainer: 'minimized',
    });
  });

  it('demotes a maximized pane in effective view if force-expand un-minimizes the other', async () => {
    const { pushForceExpand, maximize, __forTests } = await load();
    maximize('agents'); // raw: agents=maximized, explainer=minimized
    pushForceExpand('tour', 'explainer');
    // Effective explainer goes minimized→default; invariant then demotes agents.
    expect(__forTests.getEffectiveSnapshot()).toEqual(BOTH_DEFAULT);
    expect(__forTests.getRawSnapshot()).toEqual({
      agents: 'maximized',
      explainer: 'minimized',
    });
  });
});

describe('paneCollapseStore — pending focus', () => {
  it('sets focus target to rail tab when minimizing agents', async () => {
    const { minimize, consumePendingFocus } = await load();
    minimize('agents');
    expect(consumePendingFocus('rail-agents-tab')).toBe(true);
    expect(consumePendingFocus('rail-agents-tab')).toBe(false);
  });

  it('sets focus target to collapse button when restoring agents', async () => {
    const { minimize, restore, consumePendingFocus } = await load();
    minimize('agents');
    consumePendingFocus('rail-agents-tab');
    restore('agents');
    expect(consumePendingFocus('agents-collapse-btn')).toBe(true);
  });

  it('sets focus target when minimizing explainer', async () => {
    const { minimize, consumePendingFocus } = await load();
    minimize('explainer');
    expect(consumePendingFocus('rail-explainer-tab')).toBe(true);
  });

  it('returns false for non-matching target without clearing', async () => {
    const { minimize, consumePendingFocus } = await load();
    minimize('agents');
    expect(consumePendingFocus('rail-explainer-tab')).toBe(false);
    expect(consumePendingFocus('rail-agents-tab')).toBe(true);
  });

  it('does not set a focus target on no-op writes', async () => {
    const { restore, consumePendingFocus } = await load();
    restore('agents');
    expect(consumePendingFocus('agents-collapse-btn')).toBe(false);
    expect(consumePendingFocus('rail-agents-tab')).toBe(false);
  });
});
