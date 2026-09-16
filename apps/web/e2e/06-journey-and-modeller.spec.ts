import { expect, test } from './support/fixtures';

/**
 * Coordination: where a case has reached, and authoring the process.
 *
 * Plan reference: V2 sections 5.2, 5.4, 18.1 screens 14 and 20; ADR-002.
 */
test.describe('the process journey', () => {
  /**
   * A case with no process is a normal answer, not a fault.
   *
   * Orchestration never fails a case. One opened while the engine was
   * unreachable is worked by hand, and the tab has to say so — an error here
   * would send officers chasing a problem that is not one.
   */
  test('says plainly when nothing is coordinating the case', async ({ as }) => {
    const page = await as('supervisor');
    await page.goto('/cases');

    await page.locator('tbody td a').first().click();
    await expect(page).toHaveURL(/\/cases\/\d+$/, { timeout: 20_000 });

    await page.getByRole('tab', { name: 'Journey', exact: true }).click();

    // Either a diagram, or the explanation. Never an error, and never blank.
    const coordinated = page.locator('tas-bpmn-diagram');
    const uncoordinated = page.locator('tas-empty');

    await expect(coordinated.or(uncoordinated).first()).toBeVisible({ timeout: 20_000 });

    if ((await uncoordinated.count()) > 0) {
      await expect(uncoordinated.first()).toContainText(/not a fault|worked by hand/i);
    } else {
      // A drawn diagram has real shapes, not an empty canvas.
      await expect(coordinated.locator('.djs-container')).toBeVisible({ timeout: 20_000 });
    }
  });
});

test.describe('the process modeller', () => {
  test('is an administrator’s screen', async ({ as }) => {
    const assessor = await as('assessor');
    await expect(
      assessor.locator('.tas-shell__nav').getByRole('link', { name: 'Process Modeller' }),
    ).toHaveCount(0);

    const admin = await as('admin-tax');
    await expect(
      admin.locator('.tas-shell__nav').getByRole('link', { name: 'Process Modeller' }),
    ).toBeVisible();
  });

  /**
   * The validator is the server's, and the screen shows what it said.
   *
   * The panel could check that a user task names a role. It does not, because
   * the API is what refuses a deployment and a second copy of the rule in a
   * browser is a second copy that will drift.
   */
  test('shows the server’s verdict on the deployed definition', async ({ as }) => {
    const page = await as('admin-tax');
    await page.goto('/processes');

    // The canvas renders whatever is deployed, or a blank diagram if nothing
    // is. Either way the modeller must come up rather than error.
    await expect(page.locator('.tas-modeller__canvas')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Validate' }).click();

    const verdict = page.locator('.tas-alert');
    await expect(verdict).toBeVisible({ timeout: 30_000 });
    await expect(verdict).toContainText(/would be accepted|would be refused/i);
  });

  test('offers only the properties a definition here may carry', async ({ as }) => {
    const page = await as('admin-tax');
    await page.goto('/processes');
    await expect(page.locator('.tas-modeller__canvas')).toBeVisible({ timeout: 30_000 });

    const panel = page.locator('.tas-modeller__panel');
    await expect(panel).toContainText('Nothing selected');

    // Everything the engine understands but this system refuses — a Java
    // class on a service task, an execution listener, a script task — is
    // absent by design, so there is nothing here inviting an author to fill
    // in a field the deploy button will reject.
    await expect(panel).not.toContainText(/Java class|Execution listener|Script/i);
  });
});
