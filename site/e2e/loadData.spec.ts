import { test, expect } from '@playwright/test';
import { dispatchLoadData } from './helpers/loadData';

// End-to-end coverage for the LoadData `/input/...` path fix. We seed an OPFS
// directory with a small CSV, install it as the sandbox dir via the test seam
// exported from sandboxStore, and exercise the full runAgentTool dispatch for
// each path form. Releases the Step/Play gate via the toolDebugger so the
// gated tool actually completes.
//
// Sandbox loads are fast (no network, no DuckDB cold-start on most runs), so
// we tighten the helper's default timeouts here — a regression that pushes
// either phase past 5 s should fail loudly rather than silently soak up the
// 30 s default.

const CSV = 'a,b\n1,2\n3,4\n';

const SANDBOX_TIMEOUTS = { pendingTimeoutMs: 5000, resultTimeoutMs: 5000 };

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
    const res = await dispatchLoadData(page, 'mini.csv', 'bare', SANDBOX_TIMEOUTS);
    expect(res).toMatchObject({ name: 'bare', rowCount: 2, source: 'sandbox' });
  });

  test('accepts the /input/... form used by ListFiles/ReadLines', async ({
    page,
  }) => {
    const res = await dispatchLoadData(
      page,
      '/input/mini.csv',
      'inputForm',
      SANDBOX_TIMEOUTS,
    );
    expect(res).toMatchObject({
      name: 'inputForm',
      rowCount: 2,
      source: 'sandbox',
      sourcePath: 'mini.csv',
    });
  });

  test('still strips legacy `sandbox:` URI scheme', async ({ page }) => {
    const res = await dispatchLoadData(
      page,
      'sandbox:mini.csv',
      'sbScheme',
      SANDBOX_TIMEOUTS,
    );
    expect(res).toMatchObject({ name: 'sbScheme', rowCount: 2, source: 'sandbox' });
  });
});
