import { useEffect, useSyncExternalStore, type RefObject } from 'react';
import { isBrowser } from './browser';

export const PANE_COLLAPSE_STORAGE_KEY = 'haw.paneCollapse.v1';

export interface PaneCollapseSnapshot {
  exec: boolean;
  explainer: boolean;
}

export type FocusTarget =
  | 'exec-collapse-btn'
  | 'explainer-collapse-btn'
  | 'rail-exec-tab'
  | 'rail-explainer-tab';

const DEFAULT_SNAPSHOT: PaneCollapseSnapshot = { exec: false, explainer: false };

function readStorage(): PaneCollapseSnapshot | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(PANE_COLLAPSE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    return {
      exec: typeof obj.exec === 'boolean' ? obj.exec : false,
      explainer: typeof obj.explainer === 'boolean' ? obj.explainer : false,
    };
  } catch {
    return null;
  }
}

function writeStorage(snap: PaneCollapseSnapshot): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(PANE_COLLAPSE_STORAGE_KEY, JSON.stringify(snap));
  } catch {
    // ignore quota / private-mode errors
  }
}

let persistedSnapshot: PaneCollapseSnapshot = { ...DEFAULT_SNAPSHOT };
let currentEffective: PaneCollapseSnapshot = persistedSnapshot;
let hydrated = false;
let pendingFocus: FocusTarget | null = null;
const listeners = new Set<() => void>();
const forceExpandReasons = new Set<string>();

function notify(): void {
  for (const listener of listeners) listener();
}

function recomputeEffective(): void {
  currentEffective = forceExpandReasons.size > 0 ? DEFAULT_SNAPSHOT : persistedSnapshot;
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
      if (event.key !== PANE_COLLAPSE_STORAGE_KEY) return;
      const next = readStorage() ?? { ...DEFAULT_SNAPSHOT };
      if (next.exec === persistedSnapshot.exec && next.explainer === persistedSnapshot.explainer) {
        return;
      }
      persistedSnapshot = next;
      recomputeEffective();
      notify();
    });
  }
}

function setSnapshot(next: PaneCollapseSnapshot): void {
  if (next.exec === persistedSnapshot.exec && next.explainer === persistedSnapshot.explainer) {
    return;
  }
  persistedSnapshot = next;
  writeStorage(next);
  recomputeEffective();
  notify();
}

function subscribe(listener: () => void): () => void {
  hydrateOnce();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PaneCollapseSnapshot {
  hydrateOnce();
  return currentEffective;
}

function getRawSnapshot(): PaneCollapseSnapshot {
  hydrateOnce();
  return persistedSnapshot;
}

function getServerSnapshot(): PaneCollapseSnapshot {
  return DEFAULT_SNAPSHOT;
}

export function setExecCollapsed(b: boolean): void {
  hydrateOnce();
  if (persistedSnapshot.exec === b) return;
  pendingFocus = b ? 'rail-exec-tab' : 'exec-collapse-btn';
  setSnapshot({ exec: b, explainer: persistedSnapshot.explainer });
}

export function setExplainerCollapsed(b: boolean): void {
  hydrateOnce();
  if (persistedSnapshot.explainer === b) return;
  pendingFocus = b ? 'rail-explainer-tab' : 'explainer-collapse-btn';
  setSnapshot({ exec: persistedSnapshot.exec, explainer: b });
}

export function pushForceExpand(reason: 'tour' | 'pause'): void {
  hydrateOnce();
  const wasEmpty = forceExpandReasons.size === 0;
  forceExpandReasons.add(reason);
  if (wasEmpty && forceExpandReasons.size > 0) {
    recomputeEffective();
    notify();
  }
}

export function popForceExpand(reason: 'tour' | 'pause'): void {
  hydrateOnce();
  const hadIt = forceExpandReasons.delete(reason);
  if (hadIt && forceExpandReasons.size === 0) {
    recomputeEffective();
    notify();
  }
}

export function consumePendingFocus(target: FocusTarget): boolean {
  if (pendingFocus !== target) return false;
  pendingFocus = null;
  return true;
}

export function usePaneCollapse(): PaneCollapseSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useRawPaneCollapse(): PaneCollapseSnapshot {
  return useSyncExternalStore(subscribe, getRawSnapshot, getServerSnapshot);
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
