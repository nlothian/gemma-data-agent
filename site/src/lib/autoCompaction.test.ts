import { describe, it, expect } from 'vitest';
import { buildCompactionSlice, mapMessagesForLLM } from './autoCompaction';
import {
  formatToolCallToken,
  formatToolResponseToken,
} from './localLlm/toolPrompt';
import {
  COMPACTED_MARKER,
  compactionToolStub,
} from './parseAssistantContent';
import type { ChatMessage } from '../types/chat';

const userMsg = (id: string, content: string): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt: 0,
});

const assistantMsg = (
  id: string,
  content: string,
  historyContent?: string,
): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  ...(historyContent !== undefined ? { historyContent } : {}),
  createdAt: 0,
});

describe('buildCompactionSlice — trims recent tool-heavy turn', () => {
  it('returns null when there is no older round to compact', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'hello'),
      assistantMsg('a1', 'hi'),
    ];
    expect(buildCompactionSlice(messages)).toBeNull();
  });

  it('strips thinking and replaces all-but-last tool block in recent.content', () => {
    const assistant =
      '<|channel>thought\nplanning<channel|>' +
      '\n\n→ first({})\n← "one"\n\n' +
      'middle prose\n\n→ second({})\n← "two"\n\n' +
      'final prose';
    const messages: ChatMessage[] = [
      userMsg('u1', 'earlier question'),
      assistantMsg('a1', 'earlier answer'),
      userMsg('u2', 'recent question'),
      assistantMsg('a2', assistant),
    ];
    const slice = buildCompactionSlice(messages);
    expect(slice).not.toBeNull();
    const recentAssistant = slice!.recent.find((m) => m.id === 'a2')!;
    expect(recentAssistant.content).toBe(
      `${COMPACTED_MARKER}\n\n${compactionToolStub('first')}\n\nmiddle prose\n\n→ second({})\n← "two"\n\nfinal prose`,
    );
    // Original messages array is not mutated.
    expect(messages[3].content).toBe(assistant);
  });

  it('trims local-Gemma historyContent using the Gemma marker form', () => {
    const p1 =
      formatToolCallToken('First', JSON.stringify({})) +
      formatToolResponseToken('First', JSON.stringify({ r: 'one' }));
    const p2 =
      formatToolCallToken('Second', JSON.stringify({})) +
      formatToolResponseToken('Second', JSON.stringify({ r: 'two' }));
    const history = `prose ${p1} middle ${p2} tail`;
    const messages: ChatMessage[] = [
      userMsg('u1', 'earlier'),
      assistantMsg('a1', 'earlier answer'),
      userMsg('u2', 'recent'),
      assistantMsg('a2', 'ui content with →/← markers', history),
    ];
    const slice = buildCompactionSlice(messages);
    const recentAssistant = slice!.recent.find((m) => m.id === 'a2')!;
    expect(recentAssistant.historyContent).toBe(
      `prose ${compactionToolStub('First')} middle ${p2} tail`,
    );
  });

  it('leaves user messages in recent untouched', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'earlier'),
      assistantMsg('a1', 'earlier answer'),
      userMsg('u2', 'recent user content with → arrow that looks tool-y'),
      assistantMsg('a2', 'final'),
    ];
    const slice = buildCompactionSlice(messages);
    const recentUser = slice!.recent.find((m) => m.id === 'u2')!;
    expect(recentUser.content).toBe(
      'recent user content with → arrow that looks tool-y',
    );
  });
});

describe('mapMessagesForLLM — strips compacted marker from cloud-API replay', () => {
  it('drops the marker from assistant.content', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'hi'),
      assistantMsg('a1', `before${COMPACTED_MARKER}after`),
    ];
    const out = mapMessagesForLLM(messages);
    expect(out[1].content).toBe('beforeafter');
  });

  it('drops the marker from historyContent (if it somehow appeared there)', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'hi'),
      assistantMsg('a1', 'ui', `body${COMPACTED_MARKER}tail`),
    ];
    const out = mapMessagesForLLM(messages);
    expect(out[1].content).toBe('bodytail');
  });
});
