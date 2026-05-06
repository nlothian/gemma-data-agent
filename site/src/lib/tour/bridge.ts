/**
 * Imperative bridge for tour actions to drive component-local state.
 *
 * ChatSidebar and ExecutionPanel keep dropdown-open and input-text in local
 * `useState`. They register thin imperative handles here on mount; the tour's
 * action layer looks them up to perform UI operations.
 */

export interface ChatBridge {
  setModelMenuOpen(open: boolean): void;
  setInput(text: string): void;
  requestModel(modelId: string): void;
  newChat(): void;
}

export interface ExecBridge {
  setFeatureMenuOpen(open: boolean): void;
  setPythonEditor(code: string): void;
}

interface BridgeRegistry {
  chat: ChatBridge | null;
  exec: ExecBridge | null;
}

const registry: BridgeRegistry = { chat: null, exec: null };

export function registerChatBridge(b: ChatBridge): () => void {
  registry.chat = b;
  return () => {
    if (registry.chat === b) registry.chat = null;
  };
}

export function registerExecBridge(b: ExecBridge): () => void {
  registry.exec = b;
  return () => {
    if (registry.exec === b) registry.exec = null;
  };
}

export function getChatBridge(): ChatBridge {
  if (!registry.chat) {
    throw new Error('tour: chat bridge not registered (is ChatSidebar mounted?)');
  }
  return registry.chat;
}

export function getExecBridge(): ExecBridge {
  if (!registry.exec) {
    throw new Error('tour: exec bridge not registered (is ExecutionPanel mounted?)');
  }
  return registry.exec;
}
