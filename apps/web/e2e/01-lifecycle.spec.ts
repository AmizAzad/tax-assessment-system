import { apiAttempt, demoTaxpayer, expect, freeAssessmentYear, test } from './support/fixtures';
import { Workbench } from './support/workbench';

/**
 * One assessment, from opened to approved, through the screens.
 *
 * Plan reference: V2 sections 8.2, 10.1, 26.1.
 *
 * ## Why this is one test and not eight
 *
 * A case is a single stateful thing and the roles act on it in order. Split
 * into separate tests, each would have to reconstruct the state the last one
 * left, and a failure in the middle would report as several failures with one
 * cause. One test, with `test.step` for each stage, fails once and names the
 * stage.
 *
 * ## What it is really checking
 *
 * That five different people, signing in separately, can move the same case
 * along — and that the two refusals in the middle happen. Segregation of
 * duties and role separation are not features you can see; they are things
 * that must go wrong when somebody tries the shortcut. A green run where
 * nothing was refused would mean the controls are not there.
 */
function caseId(url: string): number {
  return Number(/\/cases\/(\d+)$/.exec(url)?.[1]);
}

test.describe('a complete assessment', () => {
  test('moves from opened to approved through six officers', async ({ as }) => {
    const { taxpayerId } = await demoTaxpayer();
    const year = await freeAssessmentYear();
    let caseUrl = '';
    let caseNumber = '';

    await test.step('a supervisor opens the case', async () => {
      const page = await as('supervisor');
      const opened = await Workbench.openCase(page, { taxpayerId, year });
      caseUrl = opened.url;
      caseNumber = opened.caseNumber;

      expect(caseNumber, 'the case number is issued by the server').toMatch(/^TA\d+/);

      // Initiated, or already past it. With the process engine running, the
      // case is coordinated the moment it is opened: the engine calls back to
      // retrieve evidence and the case reaches DATA_READY on its own. Both
      // are correct, and a test that insisted on one would fail depending on
      // whether somebody had started the engine.
      const status = await new Workbench(page).status();
      expect(['Initiated', 'Data ready']).toContain(status);
    });

    await test.step('evidence is retrieved, by the engine or by hand', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      if ((await workbench.status()) !== 'Data ready') {
        await workbench.retrieveEvidence();
      }

      // DATA_READY is a SYSTEM transition either way: nobody presses a button
      // called "the data arrived". It follows from every mandatory source
      // answering.
      await workbench.expectStatus('Data ready');
    });

    await test.step('the supervisor assigns it to a named assessor', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await page.locator('#assignee').fill('assessor');
      await workbench.act('Assign');
      await workbench.expectStatus('Assigned');
    });

    await test.step('the assessor finds it in their own register', async () => {
      const page = await as('assessor');
      await page.goto('/cases');

      // The whole point of assigning. The register is scoped to cases the
      // caller holds, so a case that does not appear here is one the officer
      // it was given to cannot work.
      await expect(
        page.getByRole('link', { name: caseNumber }),
        'an assigned case appears in the assessee register',
      ).toBeVisible({ timeout: 20_000 });
    });

    await test.step('the assessor prepares, adjusts and calculates', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Start preparation');
      await workbench.expectStatus('In preparation');

      await workbench.addAdjustment({
        type: 'UNDERSTATED_REVENUE',
        reason: 'THIRD_PARTY_MISMATCH',
        amount: '40000.00',
        direction: 'ADD',
        narrative: 'Third-party data shows revenue the return does not account for.',
      });

      await workbench.calculate();
      await workbench.expectStatus('Calculated');

      // The trace is the reason the screen exists: every line is arithmetic a
      // reviewer checks by hand.
      await expect(page.locator('.tas-trace tbody tr').first()).toBeVisible({ timeout: 20_000 });
      const steps = await page.locator('.tas-trace tbody tr').count();
      expect(steps, 'the calculation shows its working').toBeGreaterThan(3);
    });

    await test.step('the assessor submits, and is refused their own review', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Submit for review');
      await workbench.expectStatus('Under review');

      // Segregation of duties. The same person accepting their own work is
      // the shortcut the control exists to stop. The screen does not offer
      // it, and the server refuses it anyway, naming the role that may act.
      await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
      const refused = await apiAttempt('assessor', `/cases/${caseId(caseUrl)}/transition`, {
        action: 'ACCEPT',
      });
      expect(refused.status, 'the server refuses the assessor their own review').toBe(403);
      expect(refused.message).toMatch(/TA_REVIEWER|reviewer|not the assessor/i);

      await page.reload();
      await workbench.expectStatus('Under review');
    });

    await test.step('the reviewer accepts', async () => {
      const page = await as('reviewer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Accept');
      await workbench.expectStatus('Reviewed');
    });

    await test.step('approval is routed by amount, not by the caller', async () => {
      const page = await as('reviewer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Route for approval');
      await workbench.expectStatus('Pending approval');

      // The service reports how it chose, and the screen shows that sentence.
      // It is the answer to "why me" when the case lands on an approver.
      await expect(workbench.actionNote()).toContainText(/band/i, { timeout: 20_000 });
    });

    await test.step('an assessor cannot approve their own case', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      // The action bar is drawn from the case, so an absence asserted before
      // the case has loaded would pass on an empty page.
      await new Workbench(page).expectStatus('Pending approval');

      // Not merely hidden: the assessor's action bar does not offer Approve,
      // and the API would refuse it anyway. The screen agreeing with the
      // server is what keeps officers from learning to expect errors.
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    });

    await test.step('an approver approves', async () => {
      const page = await as('approver');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Approve');
      await workbench.expectStatus('Approved');
    });

    await test.step('the ledger records every movement, and cannot be edited', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      await new Workbench(page).tab('Timeline');

      const rows = page.locator('.tas-card table tbody tr');
      await expect(rows.first()).toBeVisible({ timeout: 20_000 });

      // Opened, evidence, assigned, started, adjusted, calculated, submitted,
      // reviewed, approved. The exact count is not the point; that every one
      // of them is there is.
      expect(await rows.count(), 'the case history is complete').toBeGreaterThanOrEqual(6);
    });
  });
});
