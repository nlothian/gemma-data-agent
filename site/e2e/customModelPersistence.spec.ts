import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

// End-to-end coverage for the custom-model persistence + restore feature
// (Change A) and the shared id-resolution helper (Change C), plus the
// "never download a model on boot" invariant (Change B).
//
// Gated on the real local Gemma .task being present, per request: this
// signals a developer with the heavyweight model checked out. The automated
// assertions here do NOT load the 3 GB model or need WebGPU.
//
// Fidelity note: we drive the real `customModelStore` against an OPFS-backed
// FileSystemFileHandle. OPFS handles auto-grant permission, so this faithfully
// exercises the "permission already granted → silently re-register, NO banner"
// path. The banner itself only appears when a fresh permission gesture is
// required (a real showOpenFilePicker handle returning 'prompt' after reload),
// which headless Chromium cannot mint without the native picker — that path is
// covered by customModelStore.test.ts (mocked queryPermission/requestPermission)
// and the manual chrome-devtools walkthrough.

const MODEL_PATH = fileURLToPath(
  new URL('../../models/gemma-4-E4B-it-web.task', import.meta.url),
);
const MODEL_EXISTS = existsSync(MODEL_PATH);

if (!MODEL_EXISTS) {
  // Surfaced in the Playwright "list" reporter output before the skip.
  console.warn(
    `\n[customModelPersistence] SKIPPED: ${MODEL_PATH} not found.\n` +
      `  This gated spec only runs when the local Gemma .task is checked out.\n`,
  );
}

// Mirrors src/lib/localLlm/customModels.ts id/label derivation for this name.
const MODEL_FILENAME = 'gemma-4-E4B-it-web.task';
const CUSTOM_ID = 'custom:gemma-4-E4B-it-web';

// Keep in lockstep with src/types/llm.ts.
const LLM_CONFIG_STORAGE_KEY = 'haw.llm.config.v1';
const LOCAL_GEMMA_ENDPOINT = 'local://gemma';

function configJson(modelId: string): string {
  return JSON.stringify({
    activeEndpoint: LOCAL_GEMMA_ENDPOINT,
    customEndpoints: [],
    apiKeys: {},
    models: { [LOCAL_GEMMA_ENDPOINT]: modelId },
    thinkingEnabled: {},
  });
}

test.describe('custom model persistence + restore', () => {
  test.skip(
    !MODEL_EXISTS,
    `models/gemma-4-E4B-it-web.task not found — gated heavyweight spec skipped`,
  );

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Fresh per-test context already isolates storage; this is belt-and-
    // suspenders so a reused server/context can't bleed state across tests.
    await page.evaluate(async (filename) => {
      const store = await import('/src/lib/localLlm/customModelStore.ts');
      await store.clearPersistedCustomModel();
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(filename);
      } catch {
        // Not present — fine.
      }
      localStorage.removeItem('haw.llm.config.v1');
    }, MODEL_FILENAME);
    await page.reload();
    await expect(page.locator('.chat-model-split')).toBeVisible();
  });

  test('persists a picked handle and silently auto-restores on reload (no banner when permission already granted)', async ({
    page,
  }) => {
    // 1. Simulate the showOpenFilePicker pick with a real (OPFS-backed)
    //    FileSystemFileHandle and run it through the actual store path.
    const persisted = await page.evaluate(
      async ({ filename, configKey, cfg }) => {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(filename, { create: true });
        const w = await fh.createWritable();
        await w.write(new Uint8Array([1, 2, 3]));
        await w.close();

        const store = await import('/src/lib/localLlm/customModelStore.ts');
        const model = await store.persistPickedHandle(fh);

        // Commit it the way ModelSelector.commitCustom would (config only —
        // we deliberately do not trigger the 3 GB ensureLoaded here).
        localStorage.setItem(configKey, cfg);
        return { id: model.id, status: store.getSnapshot().status };
      },
      {
        filename: MODEL_FILENAME,
        configKey: LLM_CONFIG_STORAGE_KEY,
        cfg: configJson(CUSTOM_ID),
      },
    );
    expect(persisted.id).toBe(CUSTOM_ID);
    expect(persisted.status).toBe('restored');

    // 2. Reload — the in-memory registry is gone, but the handle persists.
    await page.reload();
    await expect(page.locator('.chat-model-split')).toBeVisible();

    // 3. Permission is already granted (OPFS) → the store must silently
    //    re-register and reach "restored" WITHOUT ever showing the banner.
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const store = await import(
              '/src/lib/localLlm/customModelStore.ts'
            );
            store.hydrateOnce();
            return store.getSnapshot().status;
          }),
        { timeout: 10_000 },
      )
      .toBe('restored');

    // The banner must NOT be shown — no gesture is required here.
    await expect(page.getByRole('button', { name: /Restore/i })).toHaveCount(
      0,
    );

    // 4. The model is resolvable again and Change C passes a custom id
    //    through the shared resolver instead of a predefined fallback.
    const resolved = await page.evaluate(async (id) => {
      const cm = await import('/src/lib/localLlm/customModels.ts');
      return {
        inRegistry: cm.getCustomModel(id) !== undefined,
        resolvedId: cm.resolveActiveLocalModelIdOrDefault({
          activeEndpoint: 'local://gemma',
          customEndpoints: [],
          apiKeys: {},
          models: { 'local://gemma': id },
          thinkingEnabled: {},
        }),
      };
    }, CUSTOM_ID);
    expect(resolved.inRegistry).toBe(true);
    expect(resolved.resolvedId).toBe(CUSTOM_ID);
  });

  test('never requests a model file on boot (strict no-boot-download invariant)', async ({
    page,
  }) => {
    const modelRequests: string[] = [];
    page.on('request', (req) => {
      if (/\.task(\?|$)/.test(req.url())) modelRequests.push(req.url());
    });

    // Boot with a predefined model selected and an empty OPFS cache.
    await page.evaluate(
      ({ configKey, cfg }) => {
        localStorage.setItem(configKey, cfg);
      },
      { configKey: LLM_CONFIG_STORAGE_KEY, cfg: configJson('gemma-4-e2b') },
    );
    await page.reload();
    await expect(page.locator('.chat-model-split')).toBeVisible();
    // Give the idle-scheduled eager-load effect ample time to (not) fire.
    await page.waitForTimeout(4000);

    expect(modelRequests).toEqual([]);
  });
});
