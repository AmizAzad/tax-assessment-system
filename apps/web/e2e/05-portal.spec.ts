import { apiStatus, apiGet, expect, test } from './support/fixtures';

/**
 * What a taxpayer sees, and what they must never see.
 *
 * Plan reference: V2 sections 15.1 to 15.4, 20.
 *
 * The scenario the UAT pack calls the most valuable one: somebody who does
 * not work in tax, holding a demand they think is wrong. These tests cover
 * the part a script can cover — that the screen shows their own affairs, in
 * plain words, and nothing of anybody else's.
 */
test.describe('the taxpayer portal', () => {
  test('shows the taxpayer their own assessments, in plain language', async ({ as }) => {
    const page = await as('acme-finance');
    await page.goto('/portal');

    await expect(page.locator('h1')).toContainText(/tax affairs/i, { timeout: 20_000 });

    // No status codes. A person outside the domain should not have to know
    // what NOTICE_SERVED means.
    const body = await page.locator('body').innerText();
    expect(body, 'raw status codes do not reach a taxpayer').not.toMatch(
      /NOTICE_SERVED|UNDER_OBJECTION|PENDING_APPROVAL/,
    );
  });

  test('never shows the officer’s working papers', async ({ as }) => {
    const page = await as('acme-finance');
    await page.goto('/portal');

    const body = await page.locator('body').innerText();

    // The calculation trace, the adjustments and the evidence are how the
    // figure was arrived at. A taxpayer is entitled to the figure, the reasons
    // given in the notice, and the route to object — not to the file.
    expect(body).not.toMatch(/BASE_DETERMINATION|RATE_APPLICATION|LOSS_SET_OFF/);
    expect(body).not.toMatch(/Evidence snapshot|Adjustment type/);
  });

  test('cannot reach another taxpayer’s case by changing the address', async ({ as }) => {
    const page = await as('acme-finance');

    // Their own cases, from the portal's own endpoint.
    const own = await apiGet<{ id: number }[]>('acme-finance', '/portal/cases');
    const ownIds = new Set(own.map((row) => row.id));

    // Any case id that is not theirs. The portal resolves the caller's
    // taxpayer from the recorded authority and filters on it in SQL, so a
    // guessed identifier returns nothing at all.
    const foreign = [1, 2, 3, 4, 5, 6].find((id) => !ownIds.has(id));
    test.skip(foreign === undefined, 'no foreign case id available in this environment');

    // As the taxpayer, with their own token. `page.request` carries no
    // Authorization header, so it would only ever prove that an
    // anonymous caller is refused — which is a different test.
    const status = await apiStatus('acme-finance', `/portal/cases/${foreign}`);
    expect([403, 404], 'a foreign case is refused or absent, never disclosed').toContain(status);
  });

  test('the officer register refuses a taxpayer outright', async () => {
    // 403, not 401: the taxpayer is authenticated and simply may not.
    expect(await apiStatus('acme-finance', '/cases')).toBe(403);
    expect(await apiStatus('acme-finance', '/dashboard/summary')).toBe(403);
    expect(await apiStatus('acme-finance', '/reports/assessment-summary')).toBe(403);
  });
});
