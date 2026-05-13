export type AssistantSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: string; result: string | null }
  | { kind: 'thinking'; text: string; done: boolean }
  | { kind: 'compacted' };

const CALL_MARKER = '\n\n→ ';
const RESULT_MARKER = '← ';
const THINKING_OPEN = '<|channel>thought\n';
const THINKING_CLOSE = '<channel|>';
// Sentinel inserted by `trimAssistantContentForCompaction` where a thinking
// block (and possibly earlier tool blocks) were elided. Reuses the channel
// frame so the parser can detect it with the same `<channel|>` close marker.
export const COMPACTED_MARKER = '<|channel>compacted\n<channel|>';
const COMPACTED_OPEN = '<|channel>compacted\n';

/**
 * Stub that replaces every elided tool call in a compacted assistant message.
 * Shared between the cloud-API trimmer here and the local-Gemma trimmer in
 * `localLlm/toolPrompt.ts` so a typo can't drift between them.
 */
export function compactionToolStub(name: string): string {
  return `[← ${name}: result elided during compaction]`;
}

/**
 * Remove every `<|channel>thought ... <channel|>` block from an assistant
 * message body. An unterminated trailing block is dropped from the open
 * marker to the end. Used by compaction so the summarisation call doesn't
 * pay for chain-of-thought tokens.
 */
export function stripThinking(content: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < content.length) {
    const open = content.indexOf(THINKING_OPEN, cursor);
    if (open === -1) {
      out += content.slice(cursor);
      break;
    }
    out += content.slice(cursor, open);
    const close = content.indexOf(THINKING_CLOSE, open + THINKING_OPEN.length);
    if (close === -1) break;
    cursor = close + THINKING_CLOSE.length;
  }
  return out;
}

/**
 * Strip the compacted-marker sentinel before replay. The marker stays in
 * stored `content` (so the UI can render its foldable indicator) but is
 * removed here so cloud APIs don't see a Gemma-format channel tag.
 */
export function stripCompactedMarker(content: string): string {
  if (content.indexOf(COMPACTED_MARKER) === -1) return content;
  return content.split(COMPACTED_MARKER).join('');
}

/**
 * Used by `buildCompactionSlice` so the kept "recent" round doesn't drag a
 * fat tool transcript through every subsequent turn. Inserts a single
 * `COMPACTED_MARKER` at the first elision site for the UI affordance.
 */
export function trimAssistantContentForCompaction(content: string): string {
  const segments = parseAssistantContent(content);
  let lastToolIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'tool') {
      lastToolIdx = i;
      break;
    }
  }
  const hadThinking = segments.some((s) => s.kind === 'thinking');
  const hadEarlierTool = segments.some(
    (s, i) => s.kind === 'tool' && i !== lastToolIdx,
  );
  // Re-trimming an already-trimmed message: if a compacted marker is already
  // present we don't double-insert one.
  const hadCompactedMarker = segments.some((s) => s.kind === 'compacted');
  const shouldEmitMarker =
    !hadCompactedMarker && (hadThinking || hadEarlierTool);

  const parts: string[] = [];
  let markerEmitted = false;
  const emitMarkerOnce = (): void => {
    if (markerEmitted) return;
    parts.push(COMPACTED_MARKER);
    markerEmitted = true;
  };

  segments.forEach((s, i) => {
    if (s.kind === 'thinking') {
      if (shouldEmitMarker) emitMarkerOnce();
      return;
    }
    if (s.kind === 'compacted') {
      emitMarkerOnce();
      return;
    }
    if (s.kind === 'text') {
      parts.push(s.text);
      return;
    }
    if (i === lastToolIdx) {
      const head = `\n\n→ ${s.name}(${s.args})\n`;
      parts.push(s.result === null ? head + '\n' : `${head}← ${s.result}\n\n`);
      return;
    }
    if (shouldEmitMarker) emitMarkerOnce();
    parts.push(`\n\n${compactionToolStub(s.name)}\n\n`);
  });

  return parts.join('');
}

export function parseAssistantContent(content: string): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const callStart = content.indexOf(CALL_MARKER, cursor);
    const thinkStart = content.indexOf(THINKING_OPEN, cursor);
    const compactedStart = content.indexOf(COMPACTED_OPEN, cursor);

    let nextMarker: 'call' | 'thinking' | 'compacted' | null = null;
    let nextStart = Infinity;
    if (callStart !== -1 && callStart < nextStart) {
      nextMarker = 'call';
      nextStart = callStart;
    }
    if (thinkStart !== -1 && thinkStart < nextStart) {
      nextMarker = 'thinking';
      nextStart = thinkStart;
    }
    if (compactedStart !== -1 && compactedStart < nextStart) {
      nextMarker = 'compacted';
      nextStart = compactedStart;
    }

    if (nextMarker === null) {
      if (cursor < content.length) {
        segments.push({ kind: 'text', text: content.slice(cursor) });
      }
      break;
    }

    if (nextMarker === 'compacted') {
      if (compactedStart > cursor) {
        segments.push({
          kind: 'text',
          text: content.slice(cursor, compactedStart),
        });
      }
      const innerStart = compactedStart + COMPACTED_OPEN.length;
      const closeAt = content.indexOf(THINKING_CLOSE, innerStart);
      if (closeAt === -1) {
        segments.push({ kind: 'compacted' });
        break;
      }
      segments.push({ kind: 'compacted' });
      cursor = closeAt + THINKING_CLOSE.length;
      continue;
    }

    if (nextMarker === 'thinking') {
      if (thinkStart > cursor) {
        segments.push({ kind: 'text', text: content.slice(cursor, thinkStart) });
      }
      const innerStart = thinkStart + THINKING_OPEN.length;
      const closeAt = content.indexOf(THINKING_CLOSE, innerStart);
      if (closeAt === -1) {
        segments.push({
          kind: 'thinking',
          text: content.slice(innerStart),
          done: false,
        });
        break;
      }
      segments.push({
        kind: 'thinking',
        text: content.slice(innerStart, closeAt),
        done: true,
      });
      cursor = closeAt + THINKING_CLOSE.length;
      continue;
    }

    const markerStart = callStart;

    if (markerStart > cursor) {
      segments.push({ kind: 'text', text: content.slice(cursor, markerStart) });
    }

    const nameStart = markerStart + CALL_MARKER.length;
    const parenOpen = content.indexOf('(', nameStart);
    const lineEnd = content.indexOf('\n', nameStart);

    if (parenOpen === -1 || lineEnd === -1 || parenOpen > lineEnd) {
      // Malformed — emit the rest as text and stop.
      segments.push({ kind: 'text', text: content.slice(markerStart) });
      cursor = content.length;
      break;
    }

    const name = content.slice(nameStart, parenOpen).trim();
    const callLine = content.slice(parenOpen + 1, lineEnd);
    const lastParen = callLine.lastIndexOf(')');
    const args = lastParen === -1 ? callLine : callLine.slice(0, lastParen);

    let next = lineEnd + 1;
    let result: string | null = null;

    if (content.startsWith(RESULT_MARKER, next)) {
      const resultStart = next + RESULT_MARKER.length;
      const resultEnd = content.indexOf('\n\n', resultStart);
      if (resultEnd === -1) {
        result = content.slice(resultStart);
        next = content.length;
      } else {
        result = content.slice(resultStart, resultEnd);
        next = resultEnd + 2;
      }
    }

    segments.push({ kind: 'tool', name, args, result });
    cursor = next;
  }

  return segments;
}
