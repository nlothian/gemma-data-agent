import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scheduleShake } from './useAttentionShake';

describe('scheduleShake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a no-op when inactive', () => {
    const onShake = vi.fn();
    const cleanup = scheduleShake(false, onShake, 5000, 400);
    vi.advanceTimersByTime(20_000);
    expect(onShake).not.toHaveBeenCalled();
    cleanup();
  });

  it('triggers immediately when active', () => {
    const onShake = vi.fn();
    scheduleShake(true, onShake, 5000, 400);
    expect(onShake).toHaveBeenCalledWith(true);
    expect(onShake).toHaveBeenCalledTimes(1);
  });

  it('stops the shake after the duration', () => {
    const onShake = vi.fn();
    scheduleShake(true, onShake, 5000, 400);
    onShake.mockClear();
    vi.advanceTimersByTime(400);
    expect(onShake).toHaveBeenCalledWith(false);
  });

  it('re-triggers on every interval tick', () => {
    const onShake = vi.fn();
    scheduleShake(true, onShake, 5000, 400);
    onShake.mockClear();

    vi.advanceTimersByTime(5000);
    expect(onShake).toHaveBeenCalledWith(true);

    onShake.mockClear();
    vi.advanceTimersByTime(5000);
    expect(onShake).toHaveBeenCalledWith(true);
  });

  it('stops scheduling further shakes after cleanup', () => {
    const onShake = vi.fn();
    const cleanup = scheduleShake(true, onShake, 5000, 400);
    cleanup();
    onShake.mockClear();
    vi.advanceTimersByTime(20_000);
    expect(onShake).not.toHaveBeenCalledWith(true);
  });

  it('resets to false on cleanup', () => {
    const onShake = vi.fn();
    const cleanup = scheduleShake(true, onShake, 5000, 400);
    onShake.mockClear();
    cleanup();
    expect(onShake).toHaveBeenCalledWith(false);
  });
});
