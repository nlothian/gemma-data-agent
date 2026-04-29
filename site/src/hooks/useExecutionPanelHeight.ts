import { useCallback, useSyncExternalStore } from 'react';
import { isBrowser } from '../lib/browser';

export const EXEC_HEIGHT_STORAGE_KEY = 'haw.executionPanel.height';
export const MIN_HEIGHT = 200;
export const MAX_HEIGHT = 900;

function defaultHeight(): number {
  if (!isBrowser()) return 480;
  return Math.floor((window.innerHeight - 57) * (2 / 3));
}

function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return defaultHeight();
  const viewportMax = isBrowser()
    ? Math.min(MAX_HEIGHT, Math.floor((window.innerHeight - 57) * 0.85))
    : MAX_HEIGHT;
  const upper = Math.max(MIN_HEIGHT, viewportMax);
  return Math.min(upper, Math.max(MIN_HEIGHT, Math.round(value)));
}

function readStorage(): number | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(EXEC_HEIGHT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return clampHeight(parsed);
  } catch {
    return null;
  }
}

function writeStorage(height: number): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(EXEC_HEIGHT_STORAGE_KEY, String(height));
  } catch {
    // ignore quota / private-mode errors
  }
}

let currentHeight = 0;
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;
  currentHeight = defaultHeight();
  const existing = readStorage();
  if (existing !== null) currentHeight = existing;
  if (isBrowser()) {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== EXEC_HEIGHT_STORAGE_KEY) return;
      const next = readStorage();
      if (next === null || next === currentHeight) return;
      currentHeight = next;
      notify();
    });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return currentHeight || defaultHeight();
}

function getServerSnapshot(): number {
  return 480;
}

export interface UseExecutionPanelHeightResult {
  height: number;
  setHeight: (next: number) => void;
}

export function useExecutionPanelHeight(): UseExecutionPanelHeightResult {
  hydrateOnce();
  const height = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setHeight = useCallback((next: number): void => {
    const clamped = clampHeight(next);
    if (clamped === currentHeight) return;
    currentHeight = clamped;
    writeStorage(clamped);
    notify();
  }, []);

  return { height, setHeight };
}

export default useExecutionPanelHeight;
