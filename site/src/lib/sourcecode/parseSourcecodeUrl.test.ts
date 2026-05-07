import { describe, it, expect } from 'vitest';
import { parseSourcecodeUrl } from './parseSourcecodeUrl';

describe('parseSourcecodeUrl', () => {
  it('parses a line range', () => {
    expect(parseSourcecodeUrl('@sourcecode:/site/src/lib/streamChat.ts:42-58')).toEqual({
      path: 'site/src/lib/streamChat.ts',
      startLine: 42,
      endLine: 58,
    });
  });

  it('parses a single line', () => {
    expect(parseSourcecodeUrl('@sourcecode:/site/src/lib/streamChat.ts:42')).toEqual({
      path: 'site/src/lib/streamChat.ts',
      startLine: 42,
    });
  });

  it('parses a bare file (no line spec)', () => {
    expect(parseSourcecodeUrl('@sourcecode:/site/src/lib/streamChat.ts')).toEqual({
      path: 'site/src/lib/streamChat.ts',
    });
  });

  it('accepts paths without a leading slash', () => {
    expect(parseSourcecodeUrl('@sourcecode:site/src/foo.ts:1-2')).toEqual({
      path: 'site/src/foo.ts',
      startLine: 1,
      endLine: 2,
    });
  });

  it('returns null for non-@sourcecode hrefs', () => {
    expect(parseSourcecodeUrl('https://example.com')).toBeNull();
    expect(parseSourcecodeUrl('mailto:a@b.com')).toBeNull();
    expect(parseSourcecodeUrl('')).toBeNull();
    expect(parseSourcecodeUrl(null)).toBeNull();
    expect(parseSourcecodeUrl(undefined)).toBeNull();
  });

  it('returns null for an empty path', () => {
    expect(parseSourcecodeUrl('@sourcecode:')).toBeNull();
    expect(parseSourcecodeUrl('@sourcecode:/')).toBeNull();
  });

  it('drops a malformed end line and keeps just startLine', () => {
    const r = parseSourcecodeUrl('@sourcecode:/foo.ts:10-5');
    expect(r).toEqual({ path: 'foo.ts', startLine: 10 });
  });

  it('treats unparseable trailing tokens as part of the path', () => {
    // No line digits after the last colon — fall back to bare-path interpretation.
    const r = parseSourcecodeUrl('@sourcecode:/foo.ts:abc');
    expect(r).toEqual({ path: 'foo.ts:abc' });
  });

  it('rejects startLine < 1', () => {
    expect(parseSourcecodeUrl('@sourcecode:/foo.ts:0')).toEqual({ path: 'foo.ts' });
  });
});
