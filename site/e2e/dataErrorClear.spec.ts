import { test, expect } from '@playwright/test';
import { dispatchLoadData, seedSandbox } from './helpers/loadData';

// Regression coverage for the "stuck Data-tab error" bug: a failed LoadData
// left the error banner visible forever because no reset path touched it and
// it survived reloads via the persisted panel snapshot. Every one of these
// should now clear it:
//   - the Dismiss button in the error block (failed load, zero tables)
//   - clearing/changing the sandbox directory
//   - "New chat" (while preserving already-loaded tables)
//   - a page reload (the error must not be re-hydrated)

const SANDBOX_TIMEOUTS = { pendingTimeoutMs: 5000, resultTimeoutMs: 5000 };

/** Drive a failing sandbox LoadData so the Data-tab error banner shows. */
async function forceDataError(page: import('@playwright/test').Page) {
  const res = await dispatchLoadData(
    page,
    'does-not-exist.csv',
    'missing',
    SANDBOX_TIMEOUTS,
  );
  expect(res.error, 'missing sandbox file should yield a LoadData error').toBeTruthy();
  await expect(page.locator('.data-error')).toBeVisible();
}

/** Load the seeded mini.csv as table `keep` and confirm it shows. */
async function loadMiniTable(page: import('@playwright/test').Page) {
  const ok = await dispatchLoadData(page, 'mini.csv', 'keep', SANDBOX_TIMEOUTS);
  expect(ok).toMatchObject({ name: 'keep', rowCount: 2, source: 'sandbox' });
  await expect(page.getByText('1 table loaded')).toBeVisible();
}

/** Assert the error banner is gone and the pane fell back to the empty hint
 *  (the "No data loaded." text guards against a false-green where the whole
 *  panel unmounted rather than the error clearing). */
async function expectDataErrorCleared(page: import('@playwright/test').Page) {
  await expect(page.locator('.data-error')).toHaveCount(0);
  await expect(page.getByText('No data loaded.')).toBeVisible();
}

test.describe('Data-tab error is cleared by every reset path', () => {
  test.beforeEach(async ({ page }) => {
    // Suppress the first-visit onboarding tour: its "Tour step" dialog
    // overlays the data panel and intercepts the Clear all / Dismiss clicks.
    // addInitScript re-runs on the reload test too, so the flag survives.
    await page.addInitScript(() => localStorage.setItem('tour.seen', '1'));
    await page.goto('/');
    await expect(page.getByText('Choose model')).toBeVisible();
    await seedSandbox(page);
  });

  test('the Dismiss button clears a zero-table error', async ({ page }) => {
    await forceDataError(page);

    await page
      .locator('.data-error')
      .getByRole('button', { name: 'Dismiss' })
      .click();

    await expectDataErrorCleared(page);
  });

  test('"Clear all" clears a coexisting error along with the tables', async ({
    page,
  }) => {
    await loadMiniTable(page);

    await forceDataError(page);
    // Banner and the loaded table coexist until "Clear all" sweeps both.
    await expect(page.getByText('1 table loaded')).toBeVisible();

    await page
      .getByRole('button', { name: 'Clear all', exact: true })
      .click();

    await expectDataErrorCleared(page);
  });

  test('clearing the sandbox directory clears the error', async ({ page }) => {
    await forceDataError(page);

    // clearDirectory() runs the same clearAllSandboxFiles ->
    // onSandboxDirectoryChange sweep as the Sandbox-settings picker.
    await page.evaluate(async () => {
      const sb = await import('/src/lib/sandboxStore.ts');
      await sb.clearDirectory();
    });

    await expectDataErrorCleared(page);
  });

  test('"New chat" clears the error but keeps loaded tables', async ({
    page,
  }) => {
    await loadMiniTable(page);

    await forceDataError(page);
    // The error and the previously-loaded table coexist until a reset.
    await expect(page.getByText('1 table loaded')).toBeVisible();

    await page.evaluate(async () => {
      const bridge = await import('/src/lib/tour/bridge.ts');
      bridge.getChatBridge().newChat();
    });

    // New chat clears only the error — the loaded table is preserved.
    await expect(page.locator('.data-error')).toHaveCount(0);
    await expect(page.getByText('1 table loaded')).toBeVisible();
  });

  test('a page reload does not resurrect the error', async ({ page }) => {
    await forceDataError(page);

    // Let the debounced panel persist (PERSIST_DEBOUNCE_MS = 500ms) flush.
    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.getByText('Choose model')).toBeVisible();

    await expectDataErrorCleared(page);
  });
});
