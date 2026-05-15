/**
 * Uniform invalidation contract for the in-browser caches that hold
 * LoadData-derived state. Each cache (input registry, loadedTables, panel
 * tables, DuckDB virtual FS, sandbox files registry) implements `Cache` and
 * registers itself once. Lifecycle events — sandbox directory change,
 * "New chat" wipe — call `invalidateAcrossCaches(predicate)` and every cache
 * is swept uniformly, so a sandbox-source orphan in any one of them gets
 * cleaned up without per-cache cascade audits.
 */
import type { InputSource } from './duckdb';

export interface CacheMeta {
  name: string;
  source: InputSource;
  sourcePath?: string;
}

export interface Cache<TMeta extends CacheMeta = CacheMeta> {
  readonly id: string;
  list(): TMeta[];
  invalidateNames(names: Iterable<string>): Promise<void>;
  /** Run after the name sweep, for state a cache holds that isn't keyed by
   *  name (e.g. the Data-pane failed-load banner). */
  onSweep?(predicate: (m: CacheMeta) => boolean): void | Promise<void>;
}

export interface InvalidateOptions {
  /**
   * Also reconcile cache-owned state that is not tied to a specific name.
   * Use this for reset-style lifecycle events, not single-entry invalidation.
   */
  includeUnkeyedState?: boolean;
}

const caches: Cache[] = [];

export function registerCache(c: Cache): void {
  if (caches.some((existing) => existing.id === c.id)) return;
  caches.push(c);
}

export function listRegisteredCaches(): readonly Cache[] {
  return caches;
}

export async function invalidateAcrossCaches(
  predicate: (m: CacheMeta) => boolean,
  options: InvalidateOptions = {},
): Promise<void> {
  // Snapshot every cache's matching names synchronously *before* any await,
  // so caches that join data from other caches (virtualFsCache reads input
  // metadata) see consistent state.
  const work = caches.map((c) => ({
    cache: c,
    names: c.list().filter(predicate).map((m) => m.name),
  }));
  await Promise.all(
    work.map(({ cache, names }) =>
      names.length > 0 ? cache.invalidateNames(names) : Promise.resolve(),
    ),
  );
  if (!options.includeUnkeyedState) return;
  // After the name sweep, let caches reconcile name-agnostic state (e.g. a
  // Data-pane failed-load banner) so a single lifecycle event clears it too.
  await Promise.all(caches.map((c) => c.onSweep?.(predicate)));
}

export async function onSandboxDirectoryChange(): Promise<void> {
  await invalidateAcrossCaches((m) => m.source === 'sandbox', {
    includeUnkeyedState: true,
  });
}
