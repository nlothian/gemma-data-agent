import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Cache, CacheMeta } from './cacheRegistry';

beforeEach(() => {
  // Module-level `caches` array — reset so each test starts empty.
  vi.resetModules();
});

async function load() {
  return await import('./cacheRegistry');
}

describe('invalidateAcrossCaches — onSweep hook', () => {
  it('runs onSweep with the predicate, after the name sweep when opted in', async () => {
    const { registerCache, invalidateAcrossCaches } = await load();
    const order: string[] = [];
    const invalidateNames = vi.fn(async () => {
      order.push('invalidate');
    });
    const onSweep = vi.fn(() => {
      order.push('sweep');
    });
    const cache: Cache = {
      id: 'fake',
      list: () => [{ name: 'a', source: 'url' }],
      invalidateNames,
      onSweep,
    };
    registerCache(cache);

    const predicate = () => true;
    await invalidateAcrossCaches(predicate, { includeUnkeyedState: true });

    expect(invalidateNames).toHaveBeenCalledWith(['a']);
    expect(onSweep).toHaveBeenCalledWith(predicate);
    expect(order).toEqual(['invalidate', 'sweep']);
  });

  it('does not run onSweep for single-entry invalidation by default', async () => {
    const { registerCache, invalidateAcrossCaches } = await load();
    const invalidateNames = vi.fn(async () => {});
    const onSweep = vi.fn();
    const cache: Cache = {
      id: 'fake',
      list: () => [{ name: 'a', source: 'url' }],
      invalidateNames,
      onSweep,
    };
    registerCache(cache);

    await invalidateAcrossCaches(() => true);

    expect(invalidateNames).toHaveBeenCalledWith(['a']);
    expect(onSweep).not.toHaveBeenCalled();
  });

  it('still runs opted-in onSweep when no names match', async () => {
    const { registerCache, invalidateAcrossCaches } = await load();
    const invalidateNames = vi.fn(async () => {});
    const onSweep = vi.fn();
    const cache: Cache = {
      id: 'fake',
      list: () => [{ name: 'x', source: 'sandbox' }],
      invalidateNames,
      onSweep,
    };
    registerCache(cache);

    await invalidateAcrossCaches(
      (m: CacheMeta) => m.source === 'url',
      { includeUnkeyedState: true },
    );

    expect(invalidateNames).not.toHaveBeenCalled();
    expect(onSweep).toHaveBeenCalledTimes(1);
  });

  it('tolerates a cache without an onSweep hook', async () => {
    const { registerCache, invalidateAcrossCaches } = await load();
    const invalidateNames = vi.fn(async () => {});
    const cache: Cache = {
      id: 'no-sweep',
      list: () => [{ name: 'a', source: 'url' }],
      invalidateNames,
    };
    registerCache(cache);

    await expect(
      invalidateAcrossCaches(() => true, { includeUnkeyedState: true }),
    ).resolves.toBeUndefined();
    expect(invalidateNames).toHaveBeenCalledWith(['a']);
  });
});
