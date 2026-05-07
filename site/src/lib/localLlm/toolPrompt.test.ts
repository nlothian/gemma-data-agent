import { describe, it, expect } from 'vitest';
import {
  renderConversationForGemma,
  EMPTY_THOUGHT,
  CHANNEL_OPEN,
  CHANNEL_CLOSE,
  TURN_OPEN,
  TURN_CLOSE,
  TOOL_RESPONSE_CLOSE,
  type InternalMessage,
} from './toolPrompt';

describe('renderConversationForGemma — thinkingEnabled flag', () => {
  const userOnly: InternalMessage[] = [{ role: 'user', content: 'hello' }];

  it('default (omitted) emits the empty-thought marker (non-thinking)', () => {
    const prompt = renderConversationForGemma('', userOnly, []);
    const expectedSuffix = `${TURN_OPEN}model\n${EMPTY_THOUGHT}`;
    expect(prompt.endsWith(expectedSuffix)).toBe(true);
    // Sanity: EMPTY_THOUGHT is the open+close pair, so the prompt ends with CHANNEL_CLOSE.
    expect(prompt.endsWith(CHANNEL_CLOSE)).toBe(true);
  });

  it('thinkingEnabled=false matches default (empty-thought marker)', () => {
    const prompt = renderConversationForGemma('', userOnly, [], false);
    const expectedSuffix = `${TURN_OPEN}model\n${EMPTY_THOUGHT}`;
    expect(prompt.endsWith(expectedSuffix)).toBe(true);
  });

  it('thinkingEnabled=true leaves the thought channel open', () => {
    const prompt = renderConversationForGemma('', userOnly, [], true);
    const expectedSuffix = `${TURN_OPEN}model\n${CHANNEL_OPEN}thought\n`;
    expect(prompt.endsWith(expectedSuffix)).toBe(true);
    // The channel must NOT be auto-closed at the generation-prompt boundary.
    expect(prompt.endsWith(CHANNEL_CLOSE)).toBe(false);
    expect(prompt.endsWith(EMPTY_THOUGHT)).toBe(false);
  });

  it('past assistant turns are bare regardless of flag', () => {
    const messages: InternalMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const prompt = renderConversationForGemma('', messages, [], true);
    // Past assistant turn is rendered bare with no thought-channel decoration.
    expect(prompt).toContain(`${TURN_OPEN}model\na1${TURN_CLOSE}\n`);
    // The current generation prompt at the tail still respects thinkingEnabled=true.
    expect(prompt.endsWith(`${TURN_OPEN}model\n${CHANNEL_OPEN}thought\n`)).toBe(true);
  });

  it('tool-response continuation is unaffected by flag', () => {
    const messages: InternalMessage[] = [
      { role: 'user', content: 'do thing' },
      { role: 'assistant', content: 'calling tool' },
      { role: 'tool', toolName: 'foo', content: '{}' },
    ];
    const prompt = renderConversationForGemma('', messages, [], true);
    // No fresh generation prompt — the model continues the open turn after the tool response.
    expect(prompt.endsWith(TOOL_RESPONSE_CLOSE)).toBe(true);
    expect(prompt.endsWith(`${CHANNEL_OPEN}thought\n`)).toBe(false);
    expect(prompt.endsWith(`${CHANNEL_OPEN}thought\n${CHANNEL_CLOSE}`)).toBe(false);
  });
});
