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
): Promise<void> {
  // Snapshot every cache's matching names synchronously *before* any await,
  // so caches that join data from other caches (virtualFsCache reads input
  // metadata) see consistent state.
  const work = caches.map((c) => ({ cache: c, names: c.list().filter(predicate).map((m) => m.name) }));
  await Promise.all(
    work.map(({ cache, names }) =>
      names.length > 0 ? cache.invalidateNames(names) : Promise.resolve(),
    ),
  );
}

export async function onSandboxDirectoryChange(): Promise<void> {
  await invalidateAcrossCaches((m) => m.source === 'sandbox');
}
