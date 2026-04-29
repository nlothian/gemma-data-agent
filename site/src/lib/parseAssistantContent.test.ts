import { describe, it, expect } from 'vitest';
import { parseAssistantContent } from './parseAssistantContent';

describe('parseAssistantContent', () => {
  it('returns a single text segment for plain content', () => {
    expect(parseAssistantContent('hello world')).toEqual([
      { kind: 'text', text: 'hello world' },
    ]);
  });

  it('parses a single completed thinking block followed by text', () => {
    const input = '<|channel>thought\nfoo<channel|>answer';
    expect(parseAssistantContent(input)).toEqual([
      { kind: 'thinking', text: 'foo', done: true },
      { kind: 'text', text: 'answer' },
    ]);
  });

  it('emits an in-progress thinking segment with done: false when no close marker has arrived', () => {
    const input = '<|channel>thought\npartial reasoning';
    expect(parseAssistantContent(input)).toEqual([
      { kind: 'thinking', text: 'partial reasoning', done: false },
    ]);
  });

  it('handles text before and after a completed thinking block', () => {
    const input = 'intro<|channel>thought\ntheidea<channel|>conclusion';
    expect(parseAssistantContent(input)).toEqual([
      { kind: 'text', text: 'intro' },
      { kind: 'thinking', text: 'theidea', done: true },
      { kind: 'text', text: 'conclusion' },
    ]);
  });

  it('parses a thinking block followed immediately by a tool call', () => {
    const input =
      '<|channel>thought\nplan<channel|>\n\n→ doIt({"x":1})\n← {"ok":true}\n\n';
    expect(parseAssistantContent(input)).toEqual([
      { kind: 'thinking', text: 'plan', done: true },
      { kind: 'tool', name: 'doIt', args: '{"x":1}', result: '{"ok":true}' },
    ]);
  });

  it('parses multiple thinking rounds with text between them', () => {
    const input =
      '<|channel>thought\nA<channel|>between<|channel>thought\nB<channel|>';
    expect(parseAssistantContent(input)).toEqual([
      { kind: 'thinking', text: 'A', done: true },
      { kind: 'text', text: 'between' },
      { kind: 'thinking', text: 'B', done: true },
    ]);
  });

  it('respects ordering when thinking blocks are sandwiched between tool calls', () => {
    const input =
      'preface\n\n→ first({})\n← "ok"\n\n<|channel>thought\nmid<channel|>tail\n\n→ second({})\n← "done"\n\n';
    expect(parseAssistantContent(input)).toEqual([
      { kind: 'text', text: 'preface' },
      { kind: 'tool', name: 'first', args: '{}', result: '"ok"' },
      { kind: 'thinking', text: 'mid', done: true },
      { kind: 'text', text: 'tail' },
      { kind: 'tool', name: 'second', args: '{}', result: '"done"' },
    ]);
  });

  it('handles an empty thinking block', () => {
    const input = '<|channel>thought\n<channel|>after';
    expect(parseAssistantContent(input)).toEqual([
      { kind: 'thinking', text: '', done: true },
      { kind: 'text', text: 'after' },
    ]);
  });
});
