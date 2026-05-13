import { describe, expect, it } from 'vitest';
import { serialiseConversation } from './compactConversation';
import { COMPACTED_MARKER } from './parseAssistantContent';
import type { ChatMessage } from '../types/chat';

const assistantMsg = (
  content: string,
  historyContent?: string,
): ChatMessage => ({
  id: 'a1',
  role: 'assistant',
  content,
  ...(historyContent !== undefined ? { historyContent } : {}),
  createdAt: 0,
});

describe('serialiseConversation', () => {
  it('strips compacted UI markers before sending assistant text to the summarizer', () => {
    const out = serialiseConversation([
      assistantMsg(`before${COMPACTED_MARKER}after`),
    ]);

    expect(out).toBe('ASSISTANT: beforeafter');
  });

  it('strips compacted UI markers from historyContent when present', () => {
    const out = serialiseConversation([
      assistantMsg('visible', `history${COMPACTED_MARKER}tail`),
    ]);

    expect(out).toBe('ASSISTANT: historytail');
  });
});
