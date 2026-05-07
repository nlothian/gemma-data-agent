import { describe, expect, it } from 'vitest';
import {
  clampToolResultSize,
  estimateResultTokens,
  TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_TOO_LARGE_MESSAGE,
} from './toolResultLimits';

describe('clampToolResultSize', () => {
  it('passes small results through untouched for capped tools', () => {
    const small = JSON.stringify({ rows: [1, 2, 3] });
    expect(clampToolResultSize('RunSQL', small)).toBe(small);
  });

  it('passes results at exactly the cap through', () => {
    const atCap = 'x'.repeat(TOOL_RESULT_MAX_CHARS);
    expect(clampToolResultSize('RunPython', atCap)).toBe(atCap);
  });

  it('replaces oversized RunPython output with the error envelope', () => {
    const big = 'a'.repeat(TOOL_RESULT_MAX_CHARS + 1);
    const out = clampToolResultSize('RunPython', big);
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ error: TOOL_RESULT_TOO_LARGE_MESSAGE });
  });

  it.each(['RunSQL', 'RunReact', 'RunSubAgent', 'ReadLines', 'GrepCodebase'])(
    'caps %s the same way',
    (tool) => {
      const big = 'b'.repeat(TOOL_RESULT_MAX_CHARS + 100);
      const out = clampToolResultSize(tool, big);
      expect(JSON.parse(out)).toEqual({ error: TOOL_RESULT_TOO_LARGE_MESSAGE });
    },
  );

  it('clamps a ~200KB ReadLines payload to the error envelope', () => {
    const big = 'r'.repeat(200_000);
    const out = clampToolResultSize('ReadLines', big);
    expect(JSON.parse(out)).toEqual({ error: TOOL_RESULT_TOO_LARGE_MESSAGE });
  });

  it('passes a small GrepCodebase payload through untouched', () => {
    const small = JSON.stringify({ results: [{ path: 'a.ts', line: 1, lineText: 'x' }], count: 1 });
    expect(clampToolResultSize('GrepCodebase', small)).toBe(small);
  });

  it('does NOT cap non-listed tools (e.g. ListInputs, LoadData)', () => {
    const big = 'c'.repeat(TOOL_RESULT_MAX_CHARS + 1);
    expect(clampToolResultSize('ListInputs', big)).toBe(big);
    expect(clampToolResultSize('LoadData', big)).toBe(big);
  });
});

describe('estimateResultTokens', () => {
  it('returns ceil(chars/2) — a rough char-to-token upper bound', () => {
    expect(estimateResultTokens('')).toBe(0);
    expect(estimateResultTokens('a')).toBe(1);
    expect(estimateResultTokens('ab')).toBe(1);
    expect(estimateResultTokens('abc')).toBe(2);
    expect(estimateResultTokens('x'.repeat(10_000))).toBe(5_000);
  });
});
