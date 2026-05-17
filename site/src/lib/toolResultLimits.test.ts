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

  it('salvages oversized { error, stdout, stderr } by truncating fields', () => {
    const result = {
      error: 'E'.repeat(20_000),
      stdout: 'O'.repeat(20_000),
      stderr: 'R'.repeat(20_000),
    };
    const out = clampToolResultSize('RunPython', JSON.stringify(result));
    expect(out.length).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
    const parsed = JSON.parse(out);
    for (const k of ['error', 'stdout', 'stderr'] as const) {
      expect(parsed[k]).toContain('…[truncated, full=20000 chars]…');
      expect(parsed[k].length).toBeLessThan(600);
    }
  });

  it('keeps both ends of the error (head+tail)', () => {
    const error = `START${'x'.repeat(20_000)}END`;
    const out = clampToolResultSize(
      'RunPython',
      JSON.stringify({ error, stdout: '', stderr: '' }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.error.startsWith('START')).toBe(true);
    expect(parsed.error.endsWith('END')).toBe(true);
    expect(parsed.error).toContain('[truncated, full=');
  });

  it('leaves short diagnostic fields untouched while shrinking the large one', () => {
    const out = clampToolResultSize(
      'RunPython',
      JSON.stringify({ error: 'boom', stdout: 'O'.repeat(20_000), stderr: 'ok' }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('boom');
    expect(parsed.stderr).toBe('ok');
    expect(parsed.stdout).toContain('[truncated, full=20000 chars]');
  });

  it('falls back to the envelope when a non-diagnostic field is still huge', () => {
    const out = clampToolResultSize(
      'RunPython',
      JSON.stringify({ result: 'Z'.repeat(20_000), stdout: '', stderr: '' }),
    );
    expect(JSON.parse(out)).toEqual({ error: TOOL_RESULT_TOO_LARGE_MESSAGE });
  });

  it('falls back to the envelope for oversized non-object JSON', () => {
    const big = JSON.stringify('q'.repeat(TOOL_RESULT_MAX_CHARS + 1));
    expect(JSON.parse(clampToolResultSize('RunPython', big))).toEqual({
      error: TOOL_RESULT_TOO_LARGE_MESSAGE,
    });
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
