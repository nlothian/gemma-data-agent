export const CHAT_HISTORY_STORAGE_KEY = 'haw.chat.history.v1';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  error?: boolean;
}

export interface ChatHistory {
  messages: ChatMessage[];
}

export const EMPTY_CHAT_HISTORY: ChatHistory = { messages: [] };
