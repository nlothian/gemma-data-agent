import { test, expect } from '@playwright/test';
import {
  dispatchLoadData,
  runSqlDirect,
  TITANIC_COLUMNS,
} from './helpers/loadData';

// End-to-end coverage for LoadData against a real remote URL — the Titanic
// `train` CSV hosted on GitHub Gist (CORS-enabled via *.githubusercontent.com).
// Hits the network: the test will fail offline. The dispatch helper's default
// timeouts already account for DuckDB-WASM cold-start plus a network fetch.
//
// NOTE: the tour itself no longer fetches this gist — it now loads
// /tour-data/train.csv from the same origin (see localTourData.spec.ts).
// This test stays pointed at the gist on purpose: it is the only end-to-end
// exercise of LoadData against a third-party CORS-enabled host, including
// the HTTP-error surface from a remote 404. Do not retarget it to the
// same-origin copy.

const GIST_TITANIC_TRAIN_URL =
  'https://gist.githubusercontent.com/nlothian/65faed428e86c9724e83c4426d86c783/raw/7ecb4390910ee3400cc49dea0f8d1775fa53172b/train.csv';

test.describe('LoadData remote URL — Titanic train CSV', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Gates on the React island that owns the model menu — same hydration
    // signal loadData.spec.ts uses.
    await expect(page.getByText('Choose model')).toBeVisible();
  });

  test('loads the gist-hosted CSV and reports the Titanic schema + row count', async ({
    page,
  }) => {
    const res = await dispatchLoadData(page, GIST_TITANIC_TRAIN_URL, 'titanic');
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({
      name: 'titanic',
      url: GIST_TITANIC_TRAIN_URL,
      format: 'csv',
      source: 'url',
      rowCount: 891,
    });
    const colNames = (res.schema ?? []).map((c) => c.name);
    expect(colNames).toEqual(TITANIC_COLUMNS);
  });

  test('makes the loaded table queryable via DuckDB', async ({ page }) => {
    const loaded = await dispatchLoadData(
      page,
      GIST_TITANIC_TRAIN_URL,
      'titanic',
    );
    expect(loaded.error).toBeUndefined();

    // Total-row sanity check.
    const totalOutcome = (await runSqlDirect(
      page,
      'SELECT COUNT(*)::INTEGER AS n FROM titanic',
    )) as { llm: { sample_rows: unknown[][]; total_rows: number } };
    expect(totalOutcome.llm.total_rows).toBe(1);
    expect(totalOutcome.llm.sample_rows[0]?.[0]).toBe(891);

    // Aggregate that exercises an actual column from the CSV — the canonical
    // Titanic survivor split is 549 / 342. DuckDB's CSV auto-inference picks
    // VARCHAR for Survived in this file, so cast both sides to keep the
    // assertion about data values rather than type-inference heuristics.
    const survOutcome = (await runSqlDirect(
      page,
      'SELECT CAST(Survived AS INTEGER) AS s, COUNT(*)::INTEGER AS n ' +
        'FROM titanic GROUP BY s ORDER BY s',
    )) as { llm: { sample_rows: unknown[][]; total_rows: number } };
    expect(survOutcome.llm.total_rows).toBe(2);
    expect(survOutcome.llm.sample_rows).toEqual([
      [0, 549],
      [1, 342],
    ]);
  });

  test('surfaces HTTP errors verbatim when the remote URL 404s', async ({
    page,
  }) => {
    // Same gist, fabricated filename — gist serves a 404 for unknown files
    // with proper CORS headers, so the error path comes back as HTTP 404
    // rather than the CORS-aware fetch-failure message.
    const badUrl = GIST_TITANIC_TRAIN_URL.replace(
      '/train.csv',
      '/train_does_not_exist.csv',
    );
    const res = await dispatchLoadData(page, badUrl, 'missing');
    expect(res.error).toBeDefined();
    expect(res.error).toContain('404');
    expect(res.error).toContain(badUrl);
  });
});
