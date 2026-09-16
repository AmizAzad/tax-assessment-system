import { expect, test } from './support/fixtures';

/**
 * The register, its configured columns, and taking a copy away.
 *
 * Plan reference: V2 sections 6.8, 18.1 screen 3; ADR-016.
 */
test.describe('the assessment register', () => {
  test('draws the columns the server configured, not a fixed list', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    // The register asks the server for its columns and then for its rows, so
    // the table does not exist for the first moment of the page.
    await expect(page.locator('table thead th').first()).toBeVisible({ timeout: 20_000 });

    const headers = await page.locator('table thead th').allInnerTexts();
    const labels = headers.map((header) => header.replace(/[↑↓]/g, '').trim());

    // These come from `platform.grid_definition`. If the screen ever stops
    // asking, this still passes — so the assertion that matters is the next
    // one, which checks a column marked export-only is absent.
    expect(labels).toContain('Case');
    expect(labels).toContain('Status');
    expect(labels).toContain('Net payable');

    // `limitationDate`, `tin` and `jurisdictionCode` are configured
    // `exportOnly`. A queue an officer works all day stays readable; the file
    // an auditor reconciles carries the detail.
    expect(labels, 'export-only columns stay out of the working register').not.toContain(
      'Limitation date',
    );
  });

  test('sorts by a column the register offers', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');
    await expect(page.locator('table thead th').first()).toBeVisible({ timeout: 20_000 });

    const header = page.getByRole('button', { name: /^Case/ });
    await header.click();

    await expect(page.locator('table thead th').first()).toHaveAttribute(
      'aria-sort',
      /ascending|descending/,
      { timeout: 20_000 },
    );

    const links = await page.locator('tbody td a').allInnerTexts();
    const sorted = [...links].sort();
    expect(links, 'the server applied the sort').toEqual(sorted);
  });

  test('filters, and says so when nothing matches', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    await page.locator('#f-search').fill('no-such-taxpayer-anywhere');
    await page.locator('#f-search').press('Enter');

    await expect(page.locator('tas-empty')).toBeVisible({ timeout: 20_000 });
  });

  /**
   * The export.
   *
   * Asserted through the browser's own download, because "the file arrives"
   * is the property. What is inside it is covered exactly by the writer's
   * unit tests, which can check a formula-injection payload without a
   * spreadsheet.
   */
  test('exports what is on screen as a CSV the browser receives', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    await page.locator('#f-taxtype').fill('CIT');
    await page.locator('#f-taxtype').press('Enter');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      (async () => {
        await page.getByRole('button', { name: 'Export CSV' }).click();
        // A small register comes back READY and the screen offers the file.
        await page.getByRole('button', { name: 'Download', exact: true }).click({
          timeout: 60_000,
        });
      })(),
    ]);

    expect(download.suggestedFilename()).toMatch(/assessment_register.*\.csv$/i);
  });

  test('a taxpayer is not offered the export at all', async ({ as }) => {
    const page = await as('acme-finance');
    await page.goto('/portal');

    await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Export Excel' })).toHaveCount(0);
  });
});
