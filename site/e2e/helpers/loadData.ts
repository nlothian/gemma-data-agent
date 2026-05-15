// Shared Playwright helpers for exercising LoadData / runSQL through the
// real agent-tool dispatch path. The tests under e2e/*.spec.ts fire the
// gated dispatch, release it via toolDebugger, and read the result back
// off `window.__loadDataResult` — this module is the single source of truth
// for that dance so timing tweaks and seam changes only happen in one place.
//
// Playwright's default testMatch only picks up `*.spec.ts` / `*.test.ts`,
// so this file (and anything else under e2e/helpers/) is safe from being
// run as a test.

declare global {
  interface Window {
    __loadDataResult?: unknown;
  }
}

// Column order of the Titanic `train` CSV, shared by every spec that loads it
// (gist-hosted and same-origin copies have identical schemas).
export const TITANIC_COLUMNS = [
  'PassengerId',
  'Survived',
  'Pclass',
  'Name',
  'Sex',
  'Age',
  'SibSp',
  'Parch',
  'Ticket',
  'Fare',
  'Cabin',
  'Embarked',
];

// Settled shape of a LoadData dispatch as seen across the page boundary.
// Fields vary by source (URL loads carry url/format/schema; sandbox loads
// don't; errors carry only `error`), so all are optional.
export interface DispatchedLoadDataResult {
  name?: string;
  url?: string;
  format?: string;
  source?: string;
  rowCount?: number;
  schema?: { name: string; type: string }[];
  error?: string;
}

export interface DispatchLoadDataOptions {
  /** Max wait for the dispatch to reach the toolDebugger gate. */
  pendingTimeoutMs?: number;
  /** Max wait for the LoadData call to settle after the gate is released. */
  resultTimeoutMs?: number;
}

/**
 * Dispatch a LoadData call through runAgentTool, release the debugger gate,
 * and return the settled result. The default timeouts are sized for runs that
 * pay a cold DuckDB-WASM init plus a remote fetch; sandbox-only tests can
 * tighten them to surface latency regressions faster.
 */
export async function dispatchLoadData(
  page: import('@playwright/test').Page,
  url: string,
  tableName: string,
  opts: DispatchLoadDataOptions = {},
): Promise<DispatchedLoadDataResult> {
  const { pendingTimeoutMs = 10_000, resultTimeoutMs = 30_000 } = opts;
  await page.evaluate(
    async ({ url, tableName }) => {
      window.__loadDataResult = undefined;
      const tools = await import('/src/lib/agentTools.ts');
      // Fire the gated dispatch without awaiting — the gate suspends it until
      // we release it below. The result lands on window for the caller.
      void tools
        .runAgentTool('LoadData', { url, table_name: tableName }, undefined)
        .then((res) => {
          window.__loadDataResult = res;
        });
    },
    { url, tableName },
  );
  await page.waitForFunction(
    async () => {
      const dbg = await import('/src/lib/toolDebugger.ts');
      return dbg.getSnapshot().pending !== null;
    },
    null,
    { timeout: pendingTimeoutMs },
  );
  await page.evaluate(async () => {
    const dbg = await import('/src/lib/toolDebugger.ts');
    dbg.play();
  });
  await page.waitForFunction(() => window.__loadDataResult !== undefined, null, {
    timeout: resultTimeoutMs,
  });
  return page.evaluate(
    () => window.__loadDataResult,
  ) as Promise<DispatchedLoadDataResult>;
}

/**
 * Resolve a same-origin path to an absolute URL inside the page context —
 * mirrors the tour's `{TOUR_DATA_ORIGIN}` substitution so specs exercise the
 * URL fetch path (LoadData's isRemote check needs a `://` scheme).
 */
export async function resolveLocalUrl(
  page: import('@playwright/test').Page,
  path: string,
): Promise<string> {
  return page.evaluate(
    (p) => new URL(p, window.location.origin).toString(),
    path,
  );
}

/** Run a raw SQL string through the agent-tool dispatch, bypassing the gate. */
export async function runSqlDirect(page: import('@playwright/test').Page, sql: string): Promise<unknown> {
  return page.evaluate(async (sql) => {
    const tools = await import('/src/lib/agentTools.ts');
    return tools.runSQL(sql);
  }, sql);
}

/** The 2-data-row CSV written to the seeded sandbox `mini.csv`. */
export const MINI_CSV = 'a,b\n1,2\n3,4\n';

/**
 * Seed an OPFS sandbox dir with `mini.csv` and adopt it via the sandboxStore
 * test seam. The subdir is recreated each call so prior state doesn't bleed
 * across tests. Shared by every spec that needs a known sandbox file.
 */
export async function seedSandbox(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.evaluate(async (csv) => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry('e2e_sandbox', { recursive: true });
    } catch {
      // First run: nothing to remove.
    }
    const dir = await root.getDirectoryHandle('e2e_sandbox', { create: true });
    const fh = await dir.getFileHandle('mini.csv', { create: true });
    const w = await fh.createWritable();
    await w.write(csv);
    await w.close();

    const sb = await import('/src/lib/sandboxStore.ts');
    await sb.__adoptDirectoryHandleForTesting(dir);
  }, MINI_CSV);
}
