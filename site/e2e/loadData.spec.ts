import { test, expect } from '@playwright/test';

// End-to-end coverage for the LoadData `/input/...` path fix. We seed an OPFS
// directory with a small CSV, install it as the sandbox dir via the test seam
// exported from sandboxStore, and exercise the full runAgentTool dispatch for
// each path form. Releases the Step/Play gate via the chat-sidebar button so
// the gated tool actually completes.

declare global {
  interface Window {
    __loadDataResult?: unknown;
  }
}

const CSV = 'a,b\n1,2\n3,4\n';

async function seedSandbox(page: import('@playwright/test').Page) {
  await page.evaluate(async (csv) => {
    const root = await navigator.storage.getDirectory();
    // Recreate a clean subdir each run so prior state doesn't bleed across tests.
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
  }, CSV);
}

async function dispatchLoadData(
  page: import('@playwright/test').Page,
  url: string,
  tableName: string,
) {
  await page.evaluate(
    async ({ url, tableName }) => {
      window.__loadDataResult = undefined;
      const tools = await import('/src/lib/agentTools.ts');
      // Fire the gated dispatch without awaiting — the gate suspends it until
      // we explicitly release it below. The result lands on window for the test.
      void tools
        .runAgentTool('LoadData', { url, table_name: tableName }, undefined)
        .then((res) => {
          window.__loadDataResult = res;
        });
    },
    { url, tableName },
  );
  // Wait until the dispatch has actually reached the gate, then release it via
  // the toolDebugger directly — sidesteps any UI race with the Play button
  // becoming enabled.
  await page.waitForFunction(
    async () => {
      const dbg = await import('/src/lib/toolDebugger.ts');
      return dbg.getSnapshot().pending !== null;
    },
    null,
    { timeout: 5000 },
  );
  await page.evaluate(async () => {
    const dbg = await import('/src/lib/toolDebugger.ts');
    dbg.play();
  });
  await page.waitForFunction(() => window.__loadDataResult !== undefined, null, {
    timeout: 5000,
  });
  return page.evaluate(() => window.__loadDataResult);
}

test.describe('LoadData sandbox-path forms', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the chat sidebar to mount — that's the signal the React
    // islands have finished hydrating and the dynamic imports we use are
    // wired up.
    await expect(page.getByText('Choose model')).toBeVisible();
    await seedSandbox(page);
  });

  test('accepts bare sandbox-relative paths', async ({ page }) => {
    const res = await dispatchLoadData(page, 'mini.csv', 'bare');
    expect(res).toMatchObject({ name: 'bare', rowCount: 2, source: 'sandbox' });
  });

  test('accepts the /input/... form used by ListFiles/ReadLines', async ({
    page,
  }) => {
    const res = await dispatchLoadData(page, '/input/mini.csv', 'inputForm');
    expect(res).toMatchObject({
      name: 'inputForm',
      rowCount: 2,
      source: 'sandbox',
      sourcePath: 'mini.csv',
    });
  });

  test('still strips legacy `sandbox:` URI scheme', async ({ page }) => {
    const res = await dispatchLoadData(page, 'sandbox:mini.csv', 'sbScheme');
    expect(res).toMatchObject({ name: 'sbScheme', rowCount: 2, source: 'sandbox' });
  });
});
