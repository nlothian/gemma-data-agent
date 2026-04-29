import { useCallback, useSyncExternalStore } from 'react';
import { isBrowser } from '../lib/browser';

export const CHAT_WIDTH_STORAGE_KEY = 'haw.chatSidebar.width';
export const DEFAULT_WIDTH = 380;
export const MIN_WIDTH = 320;
export const MAX_WIDTH = 720;

function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH;
  const viewportMax = isBrowser()
    ? Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.6))
    : MAX_WIDTH;
  const upper = Math.max(MIN_WIDTH, viewportMax);
  return Math.min(upper, Math.max(MIN_WIDTH, Math.round(value)));
}

function readStorage(): number | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return null;
    return clampWidth(parsed);
  } catch {
    return null;
  }
}

function writeStorage(width: number): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Silently ignore quota / private-mode / access errors.
  }
}

let currentWidth: number = DEFAULT_WIDTH;
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;
  const existing = readStorage();
  if (existing !== null) currentWidth = existing;
  if (isBrowser()) {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== CHAT_WIDTH_STORAGE_KEY) return;
      const next = readStorage();
      if (next === null) return;
      if (next === currentWidth) return;
      currentWidth = next;
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
  return currentWidth;
}

function getServerSnapshot(): number {
  return DEFAULT_WIDTH;
}

export interface UseChatSidebarWidthResult {
  width: number;
  setWidth: (next: number) => void;
}

export function useChatSidebarWidth(): UseChatSidebarWidthResult {
  hydrateOnce();
  const width = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setWidth = useCallback((next: number): void => {
    const clamped = clampWidth(next);
    if (clamped === currentWidth) return;
    currentWidth = clamped;
    writeStorage(clamped);
    notify();
  }, []);

  return { width, setWidth };
}

export default useChatSidebarWidth;
