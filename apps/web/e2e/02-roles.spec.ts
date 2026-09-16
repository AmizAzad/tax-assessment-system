import { NAVIGATION, OFFICERS, ROLES, expect, test } from './support/fixtures';

/**
 * What each role can reach.
 *
 * Plan reference: V2 sections 9.1, 9.3, 20.
 *
 * ## The menu is not the control
 *
 * The API decides, and denies with 403 whatever this SPA believes. These
 * tests check that the menu **agrees** with the API, which is a different and
 * still worthwhile property: a navigation entry that leads to a refusal
 * teaches officers that errors are normal, and an officer who has learned
 * that stops reading them.
 *
 * ## Why the taxpayer is in the same table
 *
 * Because the most valuable assertion in this file is the one that says a
 * taxpayer signing in to the same application sees one entry and not eleven.
 */
test.describe('role separation', () => {
  for (const role of ROLES) {
    test(`${role} sees the right navigation`, async ({ as }) => {
      const page = await as(role);
      const nav = page.locator('.tas-shell__nav');
      const expectations = NAVIGATION[role];

      for (const label of expectations.visible) {
        await expect(
          nav.getByRole('link', { name: label, exact: true }),
          `${role} should see ${label}`,
        ).toBeVisible();
      }

      for (const label of expectations.hidden) {
        await expect(
          nav.getByRole('link', { name: label, exact: true }),
          `${role} should not see ${label}`,
        ).toHaveCount(0);
      }
    });
  }

  /**
   * A taxpayer typing an officer URL.
   *
   * The route guard is a courtesy; the API is the control. What must be true
   * is that nothing of another party's is rendered, and that the refusal is
   * visible rather than a blank screen.
   */
  test('a taxpayer who types an officer URL is refused, not shown an empty page', async ({
    as,
  }) => {
    const page = await as('acme-finance');

    await page.goto('/cases');

    // Refused, and visibly so. More than one alert can be on the page — the
    // point is that at least one says the server said no, and that no
    // taxpayer data is rendered behind it.
    await expect(page.locator('.tas-alert--danger').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('table tbody tr')).toHaveCount(0);
  });

  /**
   * Every officer can see the dashboard, and it is their own.
   *
   * The figures differ by role because the scope predicate is the same one the
   * register uses. A supervisor seeing fewer open cases than an assessor would
   * mean the scope had been inverted.
   */
  test('the dashboard is scoped to whoever is looking at it', async ({ as }) => {
    const supervisor = await as('supervisor');
    await supervisor.goto('/dashboard');
    await expect(supervisor.locator('.tas-tile').first()).toBeVisible({ timeout: 20_000 });
    const supervisorOpen = Number(
      await supervisor.locator('.tas-tile').first().locator('.tas-tile__value').innerText(),
    );

    const assessor = await as('assessor');
    await assessor.goto('/dashboard');
    await expect(assessor.locator('.tas-tile').first()).toBeVisible({ timeout: 20_000 });
    const assessorOpen = Number(
      await assessor.locator('.tas-tile').first().locator('.tas-tile__value').innerText(),
    );

    expect(
      assessorOpen,
      "an assessor's open cases are a subset of everything the supervisor sees",
    ).toBeLessThanOrEqual(supervisorOpen);
  });

  test('every officer role can sign in and reach a working screen', async ({ as }) => {
    for (const role of OFFICERS) {
      const page = await as(role);
      await expect(page.locator('.tas-shell__whoami'), `${role} is signed in`).toContainText(role);
      // Not an error page: the shell renders the app, not the "API could not
      // be reached" alert.
      await expect(page.locator('.tas-alert--danger')).toHaveCount(0);
    }
  });
});
