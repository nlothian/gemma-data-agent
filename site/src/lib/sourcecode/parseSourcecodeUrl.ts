/**
 * Parser for the `@sourcecode:` markdown-link URL scheme used by the
 * Explainer Conversation. Examples:
 *
 *   @sourcecode:/site/src/lib/streamChat.ts:42-58   → range
 *   @sourcecode:/site/src/lib/streamChat.ts:42      → single line
 *   @sourcecode:/site/src/lib/streamChat.ts          → bare file (no highlight)
 *
 * Returns null if the input doesn't look like a `@sourcecode:` URL.
 */

export interface ParsedSourcecodeUrl {
  path: string;
  startLine?: number;
  endLine?: number;
}

export const SOURCECODE_URL_PREFIX = '@sourcecode:';

export function parseSourcecodeUrl(href: string | null | undefined): ParsedSourcecodeUrl | null {
  if (!href || !href.startsWith(SOURCECODE_URL_PREFIX)) return null;
  let body = href.slice(SOURCECODE_URL_PREFIX.length);
  // Strip a single leading slash so callers can write either `:/path` or
  // `:path`. Multiple leading slashes are preserved (unusual but harmless).
  if (body.startsWith('/')) body = body.slice(1);
  if (body.length === 0) return null;

  const colon = body.lastIndexOf(':');
  if (colon === -1) {
    return { path: body };
  }
  const maybeLines = body.slice(colon + 1);
  const path = body.slice(0, colon);
  if (path.length === 0) return null;

  const range = maybeLines.match(/^(\d+)(?:-(\d+))?$/);
  if (!range) {
    // No parseable line spec — treat the whole thing as a path with a
    // literal colon (e.g. a Windows path or unusual filename).
    return { path: body };
  }
  const startLine = Number(range[1]);
  if (!Number.isFinite(startLine) || startLine < 1) return { path };
  if (range[2] === undefined) return { path, startLine };
  const endLine = Number(range[2]);
  if (!Number.isFinite(endLine) || endLine < startLine) return { path, startLine };
  return { path, startLine, endLine };
}
