import { test, expect } from '@playwright/test';
import {
  dispatchLoadData,
  resolveLocalUrl,
  runSqlDirect,
  TITANIC_COLUMNS,
} from './helpers/loadData';

// End-to-end coverage for LoadData against the same-origin tour CSV at
// /tour-data/train.csv (served from site/public/tour-data/). The tour's
// subagents-pipeline stage substitutes window.location.origin into the prompt
// at typeMessage time — see site/src/lib/tour/stages/10-subagents-pipeline.ts
// and the typeMessage substitution coverage in tour/__tests__/actions.test.ts.
// This test guards against the static asset disappearing or the path being
// renamed without the tour stage being updated in lockstep.
//
// The 404-error surface is already covered by remoteLoadData.spec.ts, so this
// file sticks to the happy path.

// Pathname only — the test resolves this against the page origin inside the
// browser context to mirror the tour stage's `{TOUR_DATA_ORIGIN}` substitution.
// LoadData's isRemote heuristic requires a `://` scheme to route through the
// URL fetch path (not the sandbox), so a bare path will not work here.
const LOCAL_TITANIC_TRAIN_PATH = '/tour-data/train.csv';

test.describe('LoadData same-origin URL — tour Titanic CSV', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Choose model')).toBeVisible();
  });

  test('serves /tour-data/train.csv with the Titanic schema and 891 rows', async ({
    page,
  }) => {
    const absoluteUrl = await resolveLocalUrl(page, LOCAL_TITANIC_TRAIN_PATH);
    const res = await dispatchLoadData(page, absoluteUrl, 'titanic');
    expect(res.error).toBeUndefined();
    expect(res).toMatchObject({
      name: 'titanic',
      url: absoluteUrl,
      format: 'csv',
      source: 'url',
      rowCount: 891,
    });
    // Same-origin: the resolved URL must point at /tour-data/train.csv, not at
    // the gist (which remoteLoadData.spec.ts covers separately).
    expect(res.url).toContain('/tour-data/train.csv');
    expect(res.url).not.toContain('gist.githubusercontent.com');
    const colNames = (res.schema ?? []).map((c) => c.name);
    expect(colNames).toEqual(TITANIC_COLUMNS);
  });

  test('makes the same-origin table queryable via DuckDB', async ({ page }) => {
    const absoluteUrl = await resolveLocalUrl(page, LOCAL_TITANIC_TRAIN_PATH);
    const loaded = await dispatchLoadData(page, absoluteUrl, 'titanic');
    expect(loaded.error).toBeUndefined();

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
});
