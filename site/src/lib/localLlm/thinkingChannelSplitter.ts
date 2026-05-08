/**
 * Streaming splitter that separates Gemma's reasoning ("thought") channel from
 * its body output. Gemma emits a thought channel via the literal markers
 *   `<|channel>thought\n` ... `<channel|>`
 * and we deliberately match only that exact open marker — `<|channel>other\n`
 * etc. is treated as plain body text.
 *
 * In `outside` mode we also recognise a bare `<channel|>` and swallow it
 * silently. The model sometimes emits reasoning + a stray close marker even
 * when the prompt's thought channel was already closed (thinking disabled);
 * the leading prose comes through as plain body, but the tag itself would
 * otherwise leak into the rendered message.
 *
 * The splitter returns an ordered list of events per feed so the caller can
 * faithfully reconstruct the original sequence (multiple opens/closes within
 * a single feed are interleaved correctly with body and thought chunks).
 *
 * Trailing chars that could grow into a marker are held back in `state.buffer`
 * so we never emit half a tag. `flushSplitter` drains whatever is left when
 * the stream ends.
 */
import { CHANNEL_CLOSE } from './toolPrompt';

const THOUGHT_OPEN = '<|channel>thought\n';
const THOUGHT_CLOSE = CHANNEL_CLOSE; // '<channel|>'

export type SplitterMode = 'outside' | 'in-thought';

export interface SplitterState {
  mode: SplitterMode;
  /** Un-emitted trailing chars retained for tag-boundary holdback. */
  buffer: string;
}

export type SplitterEvent =
  | { kind: 'body'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'open' }
  | { kind: 'close' };

export function createSplitterState(initialMode: SplitterMode): SplitterState {
  return { mode: initialMode, buffer: '' };
}

function pushText(events: SplitterEvent[], kind: 'body' | 'thought', text: string): void {
  if (!text) return;
  const last = events[events.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    events.push({ kind, text });
  }
}

export function feedSplitter(state: SplitterState, delta: string): SplitterEvent[] {
  state.buffer += delta;
  const events: SplitterEvent[] = [];

  // Loop until we run out of complete markers in the buffer; each iteration
  // either consumes a full marker (transition) or commits as much text as it
  // safely can given the holdback for the active marker, then exits.
  while (true) {
    if (state.mode === 'outside') {
      const openIdx = state.buffer.indexOf(THOUGHT_OPEN);
      const closeIdx = state.buffer.indexOf(THOUGHT_CLOSE);
      const useOpen =
        openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx);
      const useClose = !useOpen && closeIdx !== -1;
      if (useOpen) {
        pushText(events, 'body', state.buffer.slice(0, openIdx));
        state.buffer = state.buffer.slice(openIdx + THOUGHT_OPEN.length);
        state.mode = 'in-thought';
        events.push({ kind: 'open' });
        continue;
      }
      if (useClose) {
        // Stray close marker — model emitted `<channel|>` without an open.
        // Swallow it; preceding text stays as body.
        pushText(events, 'body', state.buffer.slice(0, closeIdx));
        state.buffer = state.buffer.slice(closeIdx + THOUGHT_CLOSE.length);
        continue;
      }
      const holdback = Math.max(THOUGHT_OPEN.length, THOUGHT_CLOSE.length) - 1;
      const safeLen = Math.max(0, state.buffer.length - holdback);
      pushText(events, 'body', state.buffer.slice(0, safeLen));
      state.buffer = state.buffer.slice(safeLen);
      // Release any retained suffix that cannot be a prefix of either marker.
      let kept = state.buffer;
      while (
        kept.length > 0 &&
        !THOUGHT_OPEN.startsWith(kept) &&
        !THOUGHT_CLOSE.startsWith(kept)
      ) {
        pushText(events, 'body', kept[0]);
        kept = kept.slice(1);
      }
      state.buffer = kept;
      return events;
    }

    // mode === 'in-thought'
    const idx = state.buffer.indexOf(THOUGHT_CLOSE);
    if (idx !== -1) {
      pushText(events, 'thought', state.buffer.slice(0, idx));
      state.buffer = state.buffer.slice(idx + THOUGHT_CLOSE.length);
      state.mode = 'outside';
      events.push({ kind: 'close' });
      continue;
    }
    const holdback = THOUGHT_CLOSE.length - 1;
    const safeLen = Math.max(0, state.buffer.length - holdback);
    pushText(events, 'thought', state.buffer.slice(0, safeLen));
    state.buffer = state.buffer.slice(safeLen);
    let kept = state.buffer;
    while (kept.length > 0 && !THOUGHT_CLOSE.startsWith(kept)) {
      pushText(events, 'thought', kept[0]);
      kept = kept.slice(1);
    }
    state.buffer = kept;
    return events;
  }
}

export function flushSplitter(state: SplitterState): SplitterEvent[] {
  const events: SplitterEvent[] = [];
  if (state.buffer.length === 0) return events;
  if (state.mode === 'outside') {
    pushText(events, 'body', state.buffer);
  } else {
    pushText(events, 'thought', state.buffer);
  }
  state.buffer = '';
  return events;
}
