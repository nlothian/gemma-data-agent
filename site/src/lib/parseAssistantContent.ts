export type AssistantSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; args: string; result: string | null };

const CALL_MARKER = '\n\n→ ';
const RESULT_MARKER = '← ';

export function parseAssistantContent(content: string): AssistantSegment[] {
  const segments: AssistantSegment[] = [];
  let cursor = 0;

  while (cursor < content.length) {
    const markerStart = content.indexOf(CALL_MARKER, cursor);
    if (markerStart === -1) {
      if (cursor < content.length) {
        segments.push({ kind: 'text', text: content.slice(cursor) });
      }
      break;
    }

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
