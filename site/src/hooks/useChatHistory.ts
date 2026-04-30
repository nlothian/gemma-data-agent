import { useCallback, useSyncExternalStore } from 'react';
import { isBrowser } from '../lib/browser';
import {
  CHAT_HISTORY_STORAGE_KEY,
  EMPTY_CHAT_HISTORY,
  type ChatHistory,
  type ChatMessage,
} from '../types/chat';

function isChatHistoryShape(value: unknown): value is ChatHistory {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.messages)) return false;
  return v.messages.every((m) => {
    if (!m || typeof m !== 'object') return false;
    const msg = m as Record<string, unknown>;
    return (
      typeof msg.id === 'string' &&
      (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system') &&
      typeof msg.content === 'string' &&
      (msg.historyContent === undefined || typeof msg.historyContent === 'string') &&
      (msg.kind === undefined || msg.kind === 'compaction') &&
      typeof msg.createdAt === 'number'
    );
  });
}

function readStorage(): ChatHistory | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isChatHistoryShape(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStorage(history: ChatHistory): void {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Ignore quota / private-mode errors.
  }
}

let currentHistory: ChatHistory = EMPTY_CHAT_HISTORY;
let hydrated = false;
const listeners = new Set<() => void>();

function hydrateOnce(): void {
  if (hydrated) return;
  hydrated = true;
  const existing = readStorage();
  if (existing) currentHistory = existing;
  if (isBrowser()) {
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key !== CHAT_HISTORY_STORAGE_KEY) return;
      const next = readStorage();
      if (!next) return;
      currentHistory = next;
      notify();
    });
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ChatHistory {
  return currentHistory;
}

function getServerSnapshot(): ChatHistory {
  return EMPTY_CHAT_HISTORY;
}

interface UpdateOptions {
  persist?: boolean;
}

function update(
  mutator: (prev: ChatHistory) => ChatHistory,
  options: UpdateOptions = { persist: true },
): void {
  const next = mutator(currentHistory);
  if (next === currentHistory) return;
  currentHistory = next;
  if (options.persist !== false) writeStorage(next);
  notify();
}

export interface UseChatHistoryResult {
  history: ChatHistory;
  ready: boolean;
  appendMessage: (message: ChatMessage) => void;
  updateLastAssistant: (delta: string) => void;
  appendLastAssistantHistory: (delta: string) => void;
  setLastAssistantContent: (content: string, error?: boolean) => void;
  replaceMessages: (messages: ChatMessage[]) => void;
  clear: () => void;
  flush: () => void;
}

export function useChatHistory(): UseChatHistoryResult {
  hydrateOnce();
  const history = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const appendMessage = useCallback((message: ChatMessage): void => {
    update((prev) => ({ messages: [...prev.messages, message] }));
  }, []);

  const updateLastAssistant = useCallback((delta: string): void => {
    update(
      (prev) => {
        if (prev.messages.length === 0) return prev;
        const last = prev.messages[prev.messages.length - 1];
        if (last.role !== 'assistant') return prev;
        const nextLast: ChatMessage = { ...last, content: last.content + delta };
        return { messages: [...prev.messages.slice(0, -1), nextLast] };
      },
      { persist: false },
    );
  }, []);

  const appendLastAssistantHistory = useCallback((delta: string): void => {
    if (!delta) return;
    update(
      (prev) => {
        if (prev.messages.length === 0) return prev;
        const last = prev.messages[prev.messages.length - 1];
        if (last.role !== 'assistant') return prev;
        const nextLast: ChatMessage = {
          ...last,
          historyContent: (last.historyContent ?? '') + delta,
        };
        return { messages: [...prev.messages.slice(0, -1), nextLast] };
      },
      { persist: false },
    );
  }, []);

  const setLastAssistantContent = useCallback((content: string, error = false): void => {
    update((prev) => {
      if (prev.messages.length === 0) return prev;
      const last = prev.messages[prev.messages.length - 1];
      if (last.role !== 'assistant') return prev;
      const nextLast: ChatMessage = { ...last, content, error: error || undefined };
      return { messages: [...prev.messages.slice(0, -1), nextLast] };
    });
  }, []);

  const replaceMessages = useCallback((messages: ChatMessage[]): void => {
    update(() => ({ messages }));
  }, []);

  const clear = useCallback((): void => {
    update(() => EMPTY_CHAT_HISTORY);
  }, []);

  const flush = useCallback((): void => {
    writeStorage(currentHistory);
  }, []);

  return {
    history,
    ready: hydrated,
    appendMessage,
    updateLastAssistant,
    appendLastAssistantHistory,
    setLastAssistantContent,
    replaceMessages,
    clear,
    flush,
  };
}

export default useChatHistory;
