import { describe, it, expect } from 'vitest';
import {
  COMPACTED_MARKER,
  compactionToolStub,
  parseAssistantContent,
  stripCompactedMarker,
  trimAssistantContentForCompaction,
} from './parseAssistantContent';

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

  it('recognises the compacted marker as its own segment kind', () => {
    const input = `before${COMPACTED_MARKER}after`;
    expect(parseAssistantContent(input)).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'compacted' },
      { kind: 'text', text: 'after' },
    ]);
  });
});

describe('trimAssistantContentForCompaction', () => {
  it('passes plain text through unchanged (no marker, no elision)', () => {
    expect(trimAssistantContentForCompaction('just an answer')).toBe('just an answer');
  });

  it('inserts a marker and drops thinking when nothing else is around', () => {
    const input = 'before<|channel>thought\nplan<channel|>after';
    expect(trimAssistantContentForCompaction(input)).toBe(
      `before${COMPACTED_MARKER}after`,
    );
  });

  it('keeps a single tool call intact and drops thinking with a marker', () => {
    const input =
      'intro<|channel>thought\nplan<channel|>\n\n→ doIt({"x":1})\n← {"ok":true}\n\ndone';
    expect(trimAssistantContentForCompaction(input)).toBe(
      `intro${COMPACTED_MARKER}\n\n→ doIt({"x":1})\n← {"ok":true}\n\ndone`,
    );
  });

  it('stubs every tool block except the last and emits exactly one marker', () => {
    const input =
      'a\n\n→ first({})\n← "one"\n\nb\n\n→ second({})\n← "two"\n\nc\n\n→ third({})\n← "three"\n\nd';
    const out = trimAssistantContentForCompaction(input);
    expect(out).toBe(
      `a${COMPACTED_MARKER}\n\n${compactionToolStub('first')}\n\nb\n\n${compactionToolStub('second')}\n\nc\n\n→ third({})\n← "three"\n\nd`,
    );
    expect(out.split(COMPACTED_MARKER).length - 1).toBe(1);
  });

  it('strips thinking interleaved with tool calls and inserts one marker', () => {
    const input =
      '<|channel>thought\nA<channel|>preface\n\n→ first({})\n← "ok"\n\n<|channel>thought\nB<channel|>mid\n\n→ second({})\n← "done"\n\nafter';
    expect(trimAssistantContentForCompaction(input)).toBe(
      `${COMPACTED_MARKER}preface\n\n${compactionToolStub('first')}\n\nmid\n\n→ second({})\n← "done"\n\nafter`,
    );
  });

  it('handles a tool call without a result (null result)', () => {
    // Mid-stream truncation: the `←` line never arrived.
    const input = 'pre\n\n→ orphan({"k":1})\n';
    expect(trimAssistantContentForCompaction(input)).toBe('pre\n\n→ orphan({"k":1})\n\n');
  });

  it('is idempotent: trim(trim(x)) === trim(x)', () => {
    const cases = [
      'plain prose',
      'before<|channel>thought\nplan<channel|>after',
      'a\n\n→ first({})\n← "one"\n\nb\n\n→ second({})\n← "two"\n\nc\n\n→ third({})\n← "three"\n\nd',
      '<|channel>thought\nA<channel|>preface\n\n→ first({})\n← "ok"\n\n<|channel>thought\nB<channel|>mid\n\n→ second({})\n← "done"\n\nafter',
    ];
    for (const input of cases) {
      const once = trimAssistantContentForCompaction(input);
      const twice = trimAssistantContentForCompaction(once);
      expect(twice).toBe(once);
    }
  });

  it('preserves an existing compacted marker rather than duplicating it', () => {
    const input = `prose${COMPACTED_MARKER}more prose`;
    const out = trimAssistantContentForCompaction(input);
    expect(out.split(COMPACTED_MARKER).length - 1).toBe(1);
    expect(out).toContain('prose');
    expect(out).toContain('more prose');
  });
});

describe('stripCompactedMarker', () => {
  it('removes every occurrence of the marker', () => {
    const input = `a${COMPACTED_MARKER}b${COMPACTED_MARKER}c`;
    expect(stripCompactedMarker(input)).toBe('abc');
  });

  it('is a no-op when no marker is present', () => {
    expect(stripCompactedMarker('plain text')).toBe('plain text');
  });
});

describe('compactionToolStub', () => {
  it('produces the shared stub format used by both trimmers', () => {
    expect(compactionToolStub('RunPython')).toBe(
      '[← RunPython: result elided during compaction]',
    );
  });
});
