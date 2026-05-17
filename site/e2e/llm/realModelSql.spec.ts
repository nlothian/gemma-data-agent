import { dispatchLoadData, resolveLocalUrl } from '../helpers/loadData';
import { expect, test } from '@playwright/test';

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Heavyweight end-to-end LLM suite (runs only via `npm run test:llm_tests`,
// the dir-scoped `llm` Playwright project). Unlike customModelPersistence
// .spec.ts — which deliberately never loads the real model — this spec loads
// the actual local Gemma .task into WebGPU and drives a real generation:
//
//   1. load /tour-data/train.csv as the DuckDB table `train`
//   2. load models/gemma-4-E4B-it-web.task via the ModelSelector file picker
//   3. ask the model to write+run SQL and assert a result grid is rendered
//
// Gated on the model being checked out AND WebGPU being usable. A missing
// model / absent WebGPU is a SKIP, not a failure — consistent with the
// project stance that e2e is environmentally red, not a regression signal.

// Spec lives one dir deeper than e2e/customModelPersistence.spec.ts, so the
// repo-root models/ dir is three levels up.
const MODEL_PATH = fileURLToPath(
  new URL('../../../models/gemma-4-E4B-it-web.task', import.meta.url),
);
const MODEL_EXISTS = existsSync(MODEL_PATH);

if (!MODEL_EXISTS) {
  // Surfaced in the Playwright "list" reporter output before the skip.
  console.warn(
    `\n[realModelSql] SKIPPED: ${MODEL_PATH} not found.\n` +
      `  This gated heavyweight spec only runs when the local Gemma .task\n` +
      `  is checked out. Run it with: npm run test:llm_tests\n`,
  );
}

// Mirrors src/lib/localLlm/customModels.ts id derivation for this filename
// (kept in lockstep with customModelPersistence.spec.ts).
const CUSTOM_ID = 'custom:gemma-4-E4B-it-web';

const LLM_CONFIG_STORAGE_KEY = 'haw.llm.config.v1';

const PROMPT =
  'Use SQL and show me survived percentage grouped by age groups from ' +
  'train. You will need to create age groups';

test.describe('real local Gemma — writes & runs SQL, renders a result grid', () => {
  test.skip(
    !MODEL_EXISTS,
    'models/gemma-4-E4B-it-web.task not found — gated heavyweight LLM spec skipped',
  );

  test.beforeEach(async ({ page }) => {
    // Remove the File System Access picker BEFORE app code runs so
    // ModelSelector renders the Playwright-drivable <input type="file">
    // fallback instead of the un-drivable window.showOpenFilePicker button.
    // Side effect: customModelStore.hydrateOnce() reports 'unsupported' and
    // the reload-persistence path is disabled — fine, custom models are
    // in-memory only and we never reload mid-test.
    await page.addInitScript(() => {
      try {
        delete (window as unknown as Record<string, unknown>)
          .showOpenFilePicker;
      } catch {
        /* some engines make it non-configurable — the assignment covers it */
      }
      (window as unknown as Record<string, unknown>).showOpenFilePicker =
        undefined;
    });
    // Suppress the first-visit onboarding tour: its dialog overlays the
    // chat/model UI and intercepts clicks. addInitScript re-runs on reload.
    await page.addInitScript(() =>
      localStorage.setItem('tour.seen', '1'),
    );

    await page.goto('/');
    await expect(page.getByText('Choose model')).toBeVisible();

    // Belt-and-suspenders state reset (the dev server is reused across
    // runs): drop any persisted LLM config and clear loaded tables / chat
    // history via the same New-chat path the app uses.
    await page.evaluate(async (key) => {
      localStorage.removeItem(key);
      const bridge = await import('/src/lib/tour/bridge.ts');
      bridge.getChatBridge().newChat();
    }, LLM_CONFIG_STORAGE_KEY);
    await page.reload();
    await expect(page.getByText('Choose model')).toBeVisible();
  });

  test('loads train.csv + the real model and renders a SQL result table', async ({
    page,
  }) => {
    // Model parse into WebGPU + a multi-turn local-inference agent loop is
    // slow; give generous headroom over the 15-min project timeout.
    test.setTimeout(20 * 60_000);

    // WebGPU is mandatory: the model dropdown button is disabled without it
    // and inference cannot run. Absence is environmental → skip, not fail.
    const gpu = await page.evaluate(async () => {
      const m = await import('/src/lib/localLlm/webgpu.ts');
      return m.detectWebGpu();
    });
    test.skip(
      !gpu.supported,
      `WebGPU unavailable in this browser: ${gpu.reason ?? 'unknown'} — ` +
        `environmentally red, not a regression`,
    );

    // --- Load the local model through the real ModelSelector UI ---------
    const dropdown = page.locator('[data-tour-id="chat.modelDropdown"]');
    await expect(dropdown).toBeEnabled({ timeout: 30_000 });
    await dropdown.click();
    await expect(
      page.locator('[data-tour-id="chat.modelPopover"]'),
    ).toBeVisible();

    await page.locator('.chat-model-advanced-toggle').click();
    await page
      .locator('.chat-model-fileinput input[type="file"]')
      .setInputFiles(MODEL_PATH);

    // registerCustomModel runs synchronously inside the input onChange, so
    // the registry is populated almost immediately. Confirm, then await the
    // actual MediaPipe/WebGPU load deterministically: ensureLoaded() is
    // idempotent and resolves only once the model is fully loaded (the same
    // promise commitCustom() already kicked off).
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const cm = await import('/src/lib/localLlm/customModels.ts');
            return cm.getCustomModelsSnapshot().length;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    const modelId = await page.evaluate(async () => {
      const cm = await import('/src/lib/localLlm/customModels.ts');
      return cm.getCustomModelsSnapshot().at(-1)?.id ?? null;
    });
    expect(modelId).toBe(CUSTOM_ID);

    await page.evaluate(async (id) => {
      const svc = await import('/src/lib/localLlm/llmService.ts');
      await svc.ensureLoaded(id as string);
    }, modelId);

    // Model committed + loaded → the composer is no longer "unconfigured".
    const composer = page.locator('[data-tour-id="chat.messageEntry"]');
    await expect(composer).toBeEnabled({ timeout: 60_000 });

    // --- Load the Titanic CSV as DuckDB table `train` ------------------
    const url = await resolveLocalUrl(page, '/tour-data/train.csv');
    const loaded = await dispatchLoadData(page, url, 'train');
    expect(loaded.error).toBeUndefined();
    expect(loaded).toMatchObject({
      name: 'train',
      source: 'url',
      rowCount: 891,
    });

    // --- Ask the model and let the agent loop run ----------------------
    await composer.fill(PROMPT);
    const play = page.locator('[data-tour-id="chat.playButton"]');
    await expect(play).toBeEnabled();
    await play.click();

    // onPlay sets the tool-debugger to "running" before sending, so RunSQL
    // auto-executes. This pump is a safety net against the rare interleave
    // where a tool reaches the gate before that mode flip commits; play()
    // is idempotent and only resolves a pending gate / re-asserts running.
    const pump = setInterval(() => {
      page
        .evaluate(async () => {
          const dbg = await import('/src/lib/toolDebugger.ts');
          const snap = dbg.getSnapshot();
          if (snap.mode !== 'running' || snap.pending) dbg.play();
        })
        .catch(() => {
          /* page navigating/closing — ignore */
        });
    }, 1500);

    try {
      // Pass condition: the SQL execution-panel grid renders with >=1 data
      // row. RunSQLTool.onRunning auto-switches to the SQL tab, so the grid
      // mounts on its own. We intentionally do NOT assert column names,
      // bucket edges, or percentages — the model is nondeterministic; a
      // non-empty grid proves it produced runnable SQL whose result was
      // published to the panel.
      const grid = page.locator('table.exec-grid');
      await expect(grid).toBeVisible({ timeout: 8 * 60_000 });
      await expect(grid.locator('tbody tr')).not.toHaveCount(0);
    } finally {
      clearInterval(pump);
    }
  });
});
