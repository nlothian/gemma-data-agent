import { describe, it, expect } from 'vitest';
import {
  createSplitterState,
  feedSplitter,
  flushSplitter,
  type SplitterEvent,
  type SplitterMode,
} from './thinkingChannelSplitter';

interface Aggregate {
  thought: string;
  body: string;
  opens: number;
  closes: number;
  events: SplitterEvent[];
}

function aggregate(events: SplitterEvent[], into: Aggregate): void {
  for (const e of events) {
    into.events.push(e);
    if (e.kind === 'body') into.body += e.text;
    else if (e.kind === 'thought') into.thought += e.text;
    else if (e.kind === 'open') into.opens++;
    else if (e.kind === 'close') into.closes++;
  }
}

function runAll(deltas: string[], initialMode: SplitterMode): Aggregate {
  const state = createSplitterState(initialMode);
  const acc: Aggregate = { thought: '', body: '', opens: 0, closes: 0, events: [] };
  for (const d of deltas) {
    aggregate(feedSplitter(state, d), acc);
  }
  aggregate(flushSplitter(state), acc);
  return acc;
}

describe('thinkingChannelSplitter', () => {
  it('1. starts outside, no thought — passes plain body text through', () => {
    const result = runAll(['hello world'], 'outside');
    expect(result.body).toBe('hello world');
    expect(result.thought).toBe('');
    expect(result.opens).toBe(0);
    expect(result.closes).toBe(0);
  });

  it('2. starts in-thought, closes mid-delta', () => {
    const result = runAll(['reasoning…<channel|>answer'], 'in-thought');
    expect(result.thought).toBe('reasoning…');
    expect(result.body).toBe('answer');
    expect(result.opens).toBe(0);
    expect(result.closes).toBe(1);
  });

  it('3. tag split across deltas — open', () => {
    const state = createSplitterState('outside');
    const ev1 = feedSplitter(state, 'foo<|cha');
    // Aggregate body emitted in the first call must equal "foo" (no premature
    // emission of "<|cha", which could grow into the open marker).
    const body1 = ev1.filter((e) => e.kind === 'body').map((e) => e.text).join('');
    expect(body1).toBe('foo');
    expect(ev1.some((e) => e.kind === 'open')).toBe(false);

    const ev2 = feedSplitter(state, 'nnel>thought\nbar');
    const tail = flushSplitter(state);
    const all = [...ev1, ...ev2, ...tail];
    const body = all.filter((e) => e.kind === 'body').map((e) => e.text).join('');
    const thought = all.filter((e) => e.kind === 'thought').map((e) => e.text).join('');
    expect(body).toBe('foo');
    expect(thought).toBe('bar');
    expect(all.filter((e) => e.kind === 'open')).toHaveLength(1);
  });

  it('4. tag split across deltas — close', () => {
    const state = createSplitterState('in-thought');
    const ev1 = feedSplitter(state, 'thinking<chan');
    expect(ev1.some((e) => e.kind === 'close')).toBe(false);
    const thought1 = ev1.filter((e) => e.kind === 'thought').map((e) => e.text).join('');
    expect(thought1).toBe('thinking');

    const ev2 = feedSplitter(state, 'nel|>done');
    const tail = flushSplitter(state);
    const all = [...ev1, ...ev2, ...tail];
    const thought = all.filter((e) => e.kind === 'thought').map((e) => e.text).join('');
    const body = all.filter((e) => e.kind === 'body').map((e) => e.text).join('');
    expect(thought).toBe('thinking');
    expect(body).toBe('done');
    expect(all.filter((e) => e.kind === 'close')).toHaveLength(1);
  });

  it('5. multiple rounds in one stream', () => {
    const result = runAll(
      ['<|channel>thought\nA<channel|>tool result<|channel>thought\nB<channel|>final'],
      'outside',
    );
    expect(result.opens).toBe(2);
    expect(result.closes).toBe(2);
    expect(result.thought).toBe('AB');
    expect(result.body).toBe('tool resultfinal');
    // Verify ordering: open, thought "A", close, body "tool result", open,
    // thought "B", close, body "final".
    expect(result.events.map((e) => e.kind)).toEqual([
      'open',
      'thought',
      'close',
      'body',
      'open',
      'thought',
      'close',
      'body',
    ]);
  });

  it('6. stray <channel|> outside a thought — swallowed silently', () => {
    // The model sometimes emits reasoning + a close marker even when the
    // prompt's thought channel was already closed (thinking disabled). The
    // surrounding prose comes through as body; the marker itself is dropped.
    const result = runAll(['a<channel|>b'], 'outside');
    expect(result.body).toBe('ab');
    expect(result.thought).toBe('');
    expect(result.opens).toBe(0);
    expect(result.closes).toBe(0);
  });

  it('6b. stray <channel|> split across deltas — held back, then swallowed', () => {
    const state = createSplitterState('outside');
    const ev1 = feedSplitter(state, 'a<chan');
    // "<chan" is a possible prefix of <channel|>, must be held back.
    const body1 = ev1.filter((e) => e.kind === 'body').map((e) => e.text).join('');
    expect(body1).toBe('a');
    const ev2 = feedSplitter(state, 'nel|>b');
    const tail = flushSplitter(state);
    const all = [...ev1, ...ev2, ...tail];
    const body = all.filter((e) => e.kind === 'body').map((e) => e.text).join('');
    expect(body).toBe('ab');
    expect(all.some((e) => e.kind === 'close')).toBe(false);
    expect(all.some((e) => e.kind === 'open')).toBe(false);
  });

  it('7. <|channel> prefix that is not thought\\n — released as body', () => {
    const state = createSplitterState('outside');
    const ev1 = feedSplitter(state, '<|channel>');
    // At this point the buffer is exactly "<|channel>" — still a possible
    // prefix of "<|channel>thought\n", so it must be held back.
    expect(ev1.some((e) => e.kind === 'open')).toBe(false);
    const ev2 = feedSplitter(state, 'other\n...');
    const tail = flushSplitter(state);
    const all = [...ev1, ...ev2, ...tail];
    const body = all.filter((e) => e.kind === 'body').map((e) => e.text).join('');
    const thought = all.filter((e) => e.kind === 'thought').map((e) => e.text).join('');
    expect(body).toBe('<|channel>other\n...');
    expect(thought).toBe('');
    expect(all.some((e) => e.kind === 'open')).toBe(false);
  });

  it('8. flushSplitter while in-thought drains buffered chars to thoughtDelta', () => {
    const state = createSplitterState('in-thought');
    const ev1 = feedSplitter(state, 'partial<chan');
    const thought1 = ev1.filter((e) => e.kind === 'thought').map((e) => e.text).join('');
    expect(thought1).toBe('partial');
    const tail = flushSplitter(state);
    const tailThought = tail.filter((e) => e.kind === 'thought').map((e) => e.text).join('');
    const tailBody = tail.filter((e) => e.kind === 'body').map((e) => e.text).join('');
    expect(tailThought).toBe('<chan');
    expect(tailBody).toBe('');
    expect(tail.some((e) => e.kind === 'close')).toBe(false);
  });

  it('9. char-by-char streaming matches all-at-once result', () => {
    const full = '<|channel>thought\nfoo<channel|>bar';
    const charResult = runAll(full.split(''), 'outside');
    const fullResult = runAll([full], 'outside');

    expect(charResult.thought).toBe('foo');
    expect(charResult.body).toBe('bar');
    expect(charResult.opens).toBe(1);
    expect(charResult.closes).toBe(1);

    // The aggregated totals match even though the per-feed events differ.
    expect(charResult.thought).toBe(fullResult.thought);
    expect(charResult.body).toBe(fullResult.body);
    expect(charResult.opens).toBe(fullResult.opens);
    expect(charResult.closes).toBe(fullResult.closes);
  });

  it('extra: empty thought block', () => {
    const result = runAll(['before<|channel>thought\n<channel|>after'], 'outside');
    expect(result.thought).toBe('');
    expect(result.body).toBe('beforeafter');
    expect(result.opens).toBe(1);
    expect(result.closes).toBe(1);
  });

  it('extra: open marker followed immediately by another < that does not match', () => {
    const state = createSplitterState('outside');
    const ev1 = feedSplitter(state, '<|channel>thought\nx<');
    expect(ev1.some((e) => e.kind === 'open')).toBe(true);
    const thought1 = ev1.filter((e) => e.kind === 'thought').map((e) => e.text).join('');
    expect(thought1).toBe('x');
    const ev2 = feedSplitter(state, 'channel|>y');
    const tail = flushSplitter(state);
    const all = [...ev2, ...tail];
    expect(all.some((e) => e.kind === 'close')).toBe(true);
    const body = all.filter((e) => e.kind === 'body').map((e) => e.text).join('');
    expect(body).toBe('y');
  });
});
