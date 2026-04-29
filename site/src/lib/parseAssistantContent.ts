export type AssistantSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: string; result: string | null }
  | { kind: 'thinking'; text: string; done: boolean };

const CALL_MARKER = '\n\n→ ';
const RESULT_MARKER = '← ';
const THINKING_OPEN = '<|channel>thought\n';
const THINKING_CLOSE = '<channel|>';

export function parseAssistantContent(content: string): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const callStart = content.indexOf(CALL_MARKER, cursor);
    const thinkStart = content.indexOf(THINKING_OPEN, cursor);

    // Pick whichever marker appears first (smallest non -1 index).
    let nextMarker: 'call' | 'thinking' | null = null;
    if (callStart !== -1 && (thinkStart === -1 || callStart < thinkStart)) {
      nextMarker = 'call';
    } else if (thinkStart !== -1) {
      nextMarker = 'thinking';
    }

    if (nextMarker === null) {
      if (cursor < content.length) {
        segments.push({ kind: 'text', text: content.slice(cursor) });
      }
      break;
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
