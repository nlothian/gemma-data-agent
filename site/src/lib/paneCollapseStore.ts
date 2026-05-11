import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { isBrowser } from './browser';

export const PANE_LAYOUT_STORAGE_KEY = 'haw.paneLayout.v2';

export type Pane = 'agents' | 'explainer';
export type PaneVisibility = 'default' | 'maximized' | 'minimized';

export interface PaneLayoutSnapshot {
  agents: PaneVisibility;
  explainer: PaneVisibility;
}

export type FocusTarget =
  | 'agents-collapse-btn'
  | 'explainer-collapse-btn'
  | 'rail-agents-tab'
  | 'rail-explainer-tab';

export type ForceExpandPane = Pane | 'both';

const DEFAULT_SNAPSHOT: PaneLayoutSnapshot = {
  agents: 'default',
  explainer: 'default',
};

const VISIBILITIES: ReadonlyArray<PaneVisibility> = [
  'default',
  'maximized',
  'minimized',
];

function isVisibility(v: unknown): v is PaneVisibility {
  return (
    typeof v === 'string' && (VISIBILITIES as ReadonlyArray<string>).includes(v)
  );
}

function otherPane(p: Pane): Pane {
  return p === 'agents' ? 'explainer' : 'agents';
}

function snapshotsEqual(a: PaneLayoutSnapshot, b: PaneLayoutSnapshot): boolean {
  return a.agents === b.agents && a.explainer === b.explainer;
}

// Enforce: a pane can only be 'maximized' if the other is 'minimized'.
// Used as a final guard for both persisted writes and effective recomputation
// so it is impossible for the rail and a pane to render the same target at
// the same time.
function normalize(snap: PaneLayoutSnapshot): PaneLayoutSnapshot {
  let { agents, explainer } = snap;
  if (agents === 'maximized' && explainer !== 'minimized') agents = 'default';
  if (explainer === 'maximized' && agents !== 'minimized') explainer = 'default';
  return { agents, explainer };
}

function readStorage(): PaneLayoutSnapshot | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(PANE_LAYOUT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    return normalize({
      agents: isVisibility(obj.agents) ? obj.agents : 'default',
      explainer: isVisibility(obj.explainer) ? obj.explainer : 'default',
    });
  } catch {
    return null;
  }
}

function writeStorage(snap: PaneLayoutSnapshot): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(PANE_LAYOUT_STORAGE_KEY, JSON.stringify(snap));
  } catch {
    // ignore quota / private-mode errors
  }
}

let persistedSnapshot: PaneLayoutSnapshot = { ...DEFAULT_SNAPSHOT };
let currentEffective: PaneLayoutSnapshot = persistedSnapshot;
let hydrated = false;
let pendingFocus: FocusTarget | null = null;
const listeners = new Set<() => void>();
const forceExpandReasons: { agents: Set<string>; explainer: Set<string> } = {
  agents: new Set<string>(),
  explainer: new Set<string>(),
};

function notify(): void {
  for (const listener of listeners) listener();
}

function recomputeEffective(): void {
  let { agents, explainer } = persistedSnapshot;
  if (forceExpandReasons.agents.size > 0 && agents === 'minimized') {
    agents = 'default';
  }
  if (forceExpandReasons.explainer.size > 0 && explainer === 'minimized') {
    explainer = 'default';
  }
  currentEffective = normalize({ agents, explainer });
}

function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;
  const existing = readStorage();
  if (existing !== null) {
    persistedSnapshot = existing;
  }
  recomputeEffective();
  if (isBrowser()) {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== PANE_LAYOUT_STORAGE_KEY) return;
      const next = readStorage() ?? { ...DEFAULT_SNAPSHOT };
      if (snapshotsEqual(next, persistedSnapshot)) return;
      persistedSnapshot = next;
      recomputeEffective();
      notify();
    });
  }
}

function setSnapshot(next: PaneLayoutSnapshot): void {
  const normalized = normalize(next);
  if (snapshotsEqual(normalized, persistedSnapshot)) return;
  persistedSnapshot = normalized;
  writeStorage(normalized);
  recomputeEffective();
  notify();
}

function pickFocusTarget(
  pane: Pane,
  prev: PaneVisibility,
  next: PaneVisibility,
): FocusTarget | null {
  if (next === 'minimized' && prev !== 'minimized') {
    return pane === 'agents' ? 'rail-agents-tab' : 'rail-explainer-tab';
  }
  if (next !== 'minimized' && prev === 'minimized') {
    return pane === 'agents' ? 'agents-collapse-btn' : 'explainer-collapse-btn';
  }
  return null;
}

export function setPaneState(pane: Pane, state: PaneVisibility): void {
  hydrateOnce();
  const current = persistedSnapshot;
  const other = otherPane(pane);
  const next: PaneLayoutSnapshot = { ...current };

  if (state === 'maximized') {
    next[pane] = 'maximized';
    next[other] = 'minimized';
  } else if (state === 'default') {
    next[pane] = 'default';
    if (current[other] === 'maximized') next[other] = 'default';
  } else {
    next[pane] = 'minimized';
  }

  const normalized = normalize(next);
  const focus = pickFocusTarget(pane, current[pane], normalized[pane]);
  if (focus) pendingFocus = focus;
  setSnapshot(normalized);
}

export function minimize(pane: Pane): void {
  setPaneState(pane, 'minimized');
}

export function maximize(pane: Pane): void {
  setPaneState(pane, 'maximized');
}

export function restore(pane: Pane): void {
  setPaneState(pane, 'default');
}

function effectiveChanged(prev: PaneLayoutSnapshot): boolean {
  return !snapshotsEqual(prev, currentEffective);
}

export function pushForceExpand(
  reason: 'tour' | 'pause',
  pane: ForceExpandPane = 'both',
): void {
  hydrateOnce();
  const prev = currentEffective;
  if (pane === 'agents' || pane === 'both') forceExpandReasons.agents.add(reason);
  if (pane === 'explainer' || pane === 'both') forceExpandReasons.explainer.add(reason);
  recomputeEffective();
  if (effectiveChanged(prev)) notify();
}

export function popForceExpand(
  reason: 'tour' | 'pause',
  pane: ForceExpandPane = 'both',
): void {
  hydrateOnce();
  const prev = currentEffective;
  if (pane === 'agents' || pane === 'both') forceExpandReasons.agents.delete(reason);
  if (pane === 'explainer' || pane === 'both')
    forceExpandReasons.explainer.delete(reason);
  recomputeEffective();
  if (effectiveChanged(prev)) notify();
}

export function consumePendingFocus(target: FocusTarget): boolean {
  if (pendingFocus !== target) return false;
  pendingFocus = null;
  return true;
}

function subscribe(listener: () => void): () => void {
  hydrateOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PaneLayoutSnapshot {
  hydrateOnce();
  return currentEffective;
}

function getRawSnapshot(): PaneLayoutSnapshot {
  hydrateOnce();
  return persistedSnapshot;
}

function getServerSnapshot(): PaneLayoutSnapshot {
  return DEFAULT_SNAPSHOT;
}

export function usePaneLayout(): PaneLayoutSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useRestoreFocusOnMount(
  target: FocusTarget,
  ref: RefObject<HTMLElement>,
  when: boolean,
): void {
  useEffect(() => {
    if (!when) return;
    if (consumePendingFocus(target)) {
      ref.current?.focus();
    }
  }, [target, ref, when]);
}

export const __forTests = {
  getEffectiveSnapshot: getSnapshot,
  getRawSnapshot,
  subscribe,
};
