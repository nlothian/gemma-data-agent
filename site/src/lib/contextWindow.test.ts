import { describe, it, expect } from 'vitest';
import {
  COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW,
  LOCAL_GEMMA_CONTEXT_WINDOW,
  formatTokenCount,
  getContextWindowForEndpoint,
  getPressureLevel,
  shouldAutoCompact,
} from './contextWindow';
import { LOCAL_GEMMA_ENDPOINT } from '../types/llm';

describe('getPressureLevel', () => {
  it('returns ok below 60%', () => {
    expect(getPressureLevel(0, 100)).toBe('ok');
    expect(getPressureLevel(59, 100)).toBe('ok');
  });

  it('returns warn at 60% and below 75%', () => {
    expect(getPressureLevel(60, 100)).toBe('warn');
    expect(getPressureLevel(74, 100)).toBe('warn');
  });

  it('returns danger at 75% and above', () => {
    expect(getPressureLevel(75, 100)).toBe('danger');
    expect(getPressureLevel(100, 100)).toBe('danger');
  });

  it('returns ok when max is 0', () => {
    expect(getPressureLevel(50, 0)).toBe('ok');
  });
});

describe('shouldAutoCompact', () => {
  it('is false below the 90% threshold', () => {
    expect(shouldAutoCompact(89, 100)).toBe(false);
  });

  it('is true at and above the 90% threshold', () => {
    expect(shouldAutoCompact(90, 100)).toBe(true);
    expect(shouldAutoCompact(100, 100)).toBe(true);
  });

  it('is false when max is 0', () => {
    expect(shouldAutoCompact(10, 0)).toBe(false);
  });

  it('matches COMPACTION_THRESHOLD constant', () => {
    expect(COMPACTION_THRESHOLD).toBe(0.9);
  });
});

describe('getContextWindowForEndpoint', () => {
  it('returns the local Gemma window for local endpoints', () => {
    expect(getContextWindowForEndpoint(LOCAL_GEMMA_ENDPOINT)).toBe(
      LOCAL_GEMMA_CONTEXT_WINDOW,
    );
    expect(LOCAL_GEMMA_CONTEXT_WINDOW).toBe(20_000);
  });

  it('returns the default window for other endpoints', () => {
    expect(getContextWindowForEndpoint('https://api.example.com')).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
    expect(getContextWindowForEndpoint(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindowForEndpoint(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe('formatTokenCount', () => {
  it('returns the raw number below 1000', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('formats to one decimal between 1K and 10K', () => {
    expect(formatTokenCount(1000)).toBe('1.0K');
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(9999)).toBe('10.0K');
  });

  it('rounds to whole K at 10K and above', () => {
    expect(formatTokenCount(10_000)).toBe('10K');
    expect(formatTokenCount(20_000)).toBe('20K');
    expect(formatTokenCount(128_000)).toBe('128K');
  });
});
