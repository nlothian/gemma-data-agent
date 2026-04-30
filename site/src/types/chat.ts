export const CHAT_HISTORY_STORAGE_KEY = 'haw.chat.history.v1';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** UI-facing text. Includes thinking blocks and `→/←` tool-call markers. */
  content: string;
  /**
   * Replay-facing text used when this message is fed back to the model on a
   * later turn. For local-Gemma assistant turns this contains body text plus
   * proper `<|tool_call>` / `<|tool_response>` tokens — the format the model
   * was trained on. Absent on user messages and on cloud-API assistant turns
   * (where `content` is already the right shape).
   */
  historyContent?: string;
  /**
   * When set, this row replaces a span of older messages in the UI as a
   * collapsible "Compacted" block. `content` holds the summary text. The
   * marker is filtered out of `messages[]` at request time and its summary
   * is appended to the system prompt instead — see `sendPrompt`.
   */
  kind?: 'compaction';
  createdAt: number;
  error?: boolean;
}

export interface ChatHistory {
  messages: ChatMessage[];
}

export const EMPTY_CHAT_HISTORY: ChatHistory = { messages: [] };
