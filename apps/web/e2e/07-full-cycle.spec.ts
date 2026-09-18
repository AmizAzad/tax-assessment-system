import type { Page } from '@playwright/test';
import { EvidenceRecorder } from './support/evidence';
import { apiGet, apiStatus, apiToken, expect, freeAssessmentYear, test } from './support/fixtures';
import { Workbench } from './support/workbench';

/**
 * One assessment, initiation to closure, photographed at every step.
 *
 * Plan reference: V2 sections 8.2, 10.1, 13.1 to 13.7, 14.1 to 14.6, 26.1.
 *
 * ## How this differs from 01-lifecycle
 *
 * `01-lifecycle.spec.ts` proves that six officers can move a case from opened
 * to approved. This one carries the same case through the rest of its life --
 * notice, service, objection, decision, closure -- and writes an evidence
 * record and a screenshot for every step, so the run can be read as a document
 * by somebody who has never seen the software.
 *
 * ## What it refuses to pretend
 *
 * Several transitions in the table belong to SYSTEM and are driven by no
 * screen. Where a screen drives one as a side effect of a real act, that is
 * recorded as a transition and the description says so. Where nothing drives
 * one at all, the gap is recorded as a gap. `FINALISE` is the important case:
 * the API grants it to approvers and supervisors, the web application calls it
 * from nowhere, and the run says that in as many words rather than dressing an
 * arranged call up as an officer's click.
 *
 * ## Why the edge cases run on their own cases
 *
 * `CANCEL` is terminal and `REQUEST_INFO` parks a case on a taxpayer who
 * cannot reach the workbench. Either one on the main case would end the
 * journey the document exists to show, so each gets a throwaway case of its
 * own at the end of the run.
 */

const API = process.env['E2E_API'] ?? 'http://localhost:3000';

let recorder: EvidenceRecorder;

/**
 * Ask the platform to finalise an approved case.
 *
 * Arrangement, never the act under test. Nothing in `apps/web` calls
 * `POST /cases/:id/finalise` and the process definition does not either, so
 * `APPROVED --FINALISE--> FINALISED` cannot be reached by any officer through
 * any screen. Everything after it can, which is why the run arranges this one
 * move and records it as the hole it is.
 */
async function finaliseOutsideTheUi(caseId: number): Promise<void> {
  const token = await apiToken('approver');
  const response = await fetch(`${API}/api/v1/cases/${caseId}/finalise`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) {
    throw new Error(
      `Could not finalise case ${caseId}: HTTP ${response.status} ${await response.text()}`,
    );
  }
}

/** Take a case from opened to in-preparation. The preamble the edge cases need. */
async function prepareThrowawayCase(
  supervisor: Page,
  assessor: Page,
): Promise<{ url: string; caseNumber: string }> {
  const opened = await Workbench.openCase(supervisor, { year: await freeAssessmentYear() });
  const workbench = new Workbench(supervisor);

  if ((await workbench.status()) !== 'Data ready') {
    await workbench.retrieveEvidence();
  }
  await workbench.expectStatus('Data ready');

  await supervisor.locator('#assignee').fill('assessor');
  await workbench.act('Assign');
  await workbench.expectStatus('Assigned');

  await assessor.goto(opened.url);
  const assessorWorkbench = new Workbench(assessor);
  await assessorWorkbench.act('Start preparation');
  await assessorWorkbench.expectStatus('In preparation');

  return opened;
}

test.describe('a documented assessment', () => {
  test.beforeAll(() => {
    EvidenceRecorder.reset();
    recorder = new EvidenceRecorder();
  });

  test('runs from initiation to closure, and says what it could not drive', async ({ as }) => {
    // Three cases, nine officers and a dispute. The suite-wide 60 second
    // budget is for a single stage, not for a whole case history.
    test.setTimeout(900_000);

    let caseUrl = '';
    let caseNumber = '';
    let caseId = 0;

    await test.step('a supervisor opens the case', async () => {
      const page = await as('supervisor');
      const opened = await Workbench.openCase(page, { year: await freeAssessmentYear() });
      caseUrl = opened.url;
      caseNumber = opened.caseNumber;
      caseId = Number(/\/cases\/(\d+)$/.exec(caseUrl)?.[1]);

      expect(caseNumber, 'the case number is issued by the server').toMatch(/^TA\d+/);

      const workbench = new Workbench(page);
      expect(['Initiated', 'Data ready']).toContain(await workbench.status());

      await recorder.capture(page, {
        id: 'open-case',
        title: 'The authority opens an assessment',
        actor: 'supervisor',
        transition: '(none) --INITIATE--> INITIATED',
        kind: 'transition',
        description:
          'A supervisor opens a desk assessment against a company for one tax year, giving the ' +
          'reason it was selected. Nothing is assessed yet: opening a case is the authority ' +
          'putting on record that it intends to look at this period, which starts the ' +
          'limitation clock and makes every later act attributable.',
        expected: 'The register issues a case number of the form TA…, and the case exists.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the evidence arrives and the case becomes workable', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      // The process engine calls back to refresh evidence the moment a case is
      // opened, so the case may already be past this. Pressing the button
      // where it has not is the same act by hand.
      const engineDroveIt = (await workbench.status()) === 'Data ready';
      if (!engineDroveIt) {
        await workbench.retrieveEvidence();
      }
      await workbench.expectStatus('Data ready');
      await workbench.tab('Evidence');

      await recorder.capture(page, {
        id: 'evidence-retrieved',
        title: 'Third-party evidence is gathered',
        actor: engineDroveIt ? 'system (process engine)' : 'supervisor',
        transition: 'INITIATED --RETRIEVE_DATA--> DATA_READY',
        kind: 'transition',
        description:
          'The platform asks every configured source for what it holds on this taxpayer: the ' +
          'filed return, bank interest, third-party sales data. The case becomes workable only ' +
          'once every mandatory source has answered, which is why nobody presses a button ' +
          `called "the data arrived". ${
            engineDroveIt
              ? 'Here the process engine drove it, unprompted, seconds after the case opened.'
              : 'Here no engine was coordinating the case, so a supervisor asked for the refresh by hand.'
          }`,
        expected:
          'The status reads Data ready and the evidence tab lists the sources that answered.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the supervisor assigns it to a named assessor', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await page.locator('#assignee').fill('assessor');
      await workbench.act('Assign');
      await workbench.expectStatus('Assigned');

      await recorder.capture(page, {
        id: 'assign-to-assessor',
        title: 'The case is given to a named officer',
        actor: 'supervisor',
        transition: 'DATA_READY --ASSIGN--> ASSIGNED',
        kind: 'transition',
        description:
          'A supervisor hands the case to a particular assessor by name. The server refuses an ' +
          'assignment that names nobody, because a case recorded as assigned but sitting in no ' +
          "officer's queue is worse than one still waiting to be given out.",
        expected: 'The status reads Assigned and the header records who holds the case.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor finds it in their own register', async () => {
      const page = await as('assessor');
      await page.goto('/cases');

      await expect(
        page.getByRole('link', { name: caseNumber }),
        'an assigned case appears in the assessee register',
      ).toBeVisible({ timeout: 20_000 });

      await recorder.capture(page, {
        id: 'assessor-register',
        title: 'The work reaches the officer who must do it',
        actor: 'assessor',
        transition: null,
        kind: 'observation',
        description:
          'The register each officer sees is scoped to the cases they hold. This is the whole ' +
          'point of assigning: a case that does not appear here is one its owner cannot find ' +
          'and therefore will not work.',
        expected: `The case number ${caseNumber} is listed in the assessor's own register.`,
        statusAfter: null,
      });
    });

    await test.step('the assessor starts preparing', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Start preparation');
      await workbench.expectStatus('In preparation');

      await recorder.capture(page, {
        id: 'start-preparation',
        title: 'The assessor takes the case up',
        actor: 'assessor',
        transition: 'ASSIGNED --START--> IN_PREPARATION',
        kind: 'transition',
        description:
          'Starting preparation is the assessor accepting the case as their own work. From here ' +
          'the figures may be changed, and every change is attributed to them. The separate ' +
          'step exists so that the time a case sat unopened is visible.',
        expected: 'The status reads In preparation.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor records an adjustment against the return', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.addAdjustment({
        type: 'UNDERSTATED_REVENUE',
        reason: 'THIRD_PARTY_MISMATCH',
        amount: '40000.00',
        direction: 'ADD',
        narrative: 'Third-party data shows revenue the return does not account for.',
      });

      await recorder.capture(page, {
        id: 'record-adjustment',
        title: 'The assessor states what the return got wrong',
        actor: 'assessor',
        transition: null,
        kind: 'observation',
        description:
          'The assessor adds forty thousand to declared revenue, citing a mismatch with ' +
          'third-party data. An adjustment is a claim about the facts and must carry its type, ' +
          'its statutory reason and a narrative, because this is the paragraph the taxpayer ' +
          'will be answering if they object.',
        expected: 'The adjustment appears in the case with its amount, reason and narrative.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor calculates the liability', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.calculate();
      await workbench.expectStatus('Calculated');

      await expect(page.locator('.tas-trace tbody tr').first()).toBeVisible({ timeout: 20_000 });
      expect(
        await page.locator('.tas-trace tbody tr').count(),
        'the calculation shows its working',
      ).toBeGreaterThan(3);

      await recorder.capture(page, {
        id: 'calculate',
        title: 'The liability is computed, showing its working',
        actor: 'assessor',
        transition: 'IN_PREPARATION --CALCULATE--> CALCULATED',
        kind: 'transition',
        description:
          'The server applies the rule set for this jurisdiction and year to the evidence and ' +
          'the adjustments. It returns not only the figure but the trace: every step, in order, ' +
          'with the amount before and after. A reviewer checks the trace by hand, which is why ' +
          'the right answer reached by the wrong route is treated as a defect here.',
        expected:
          'The status reads Calculated and the trace lists more than three arithmetic steps.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor submits for review', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Submit for review');
      await workbench.expectStatus('Under review');

      await recorder.capture(page, {
        id: 'submit-for-review',
        title: 'The assessment goes for a second pair of eyes',
        actor: 'assessor',
        transition: 'CALCULATED --SUBMIT--> UNDER_REVIEW',
        kind: 'transition',
        description:
          'No assessment leaves the authority on one officer signature. Submitting hands the ' +
          'work to a reviewer and closes the assessor out of it, which is the moment the ' +
          'separation of duties starts to bite.',
        expected: 'The status reads Under review.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor is refused their own review', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.actAndExpectRefusal('Accept', /TA_REVIEWER|reviewer|not the assessor/i);
      await workbench.expectStatus('Under review');

      await recorder.capture(page, {
        id: 'assessor-refused-own-review',
        title: 'The assessor cannot accept their own work',
        actor: 'assessor',
        transition: null,
        kind: 'refusal',
        description:
          'The assessor presses Accept on the case they just wrote. The server refuses and names ' +
          'the role that may act. Segregation of duties is not a feature anybody can see working; ' +
          'it is only visible when somebody tries the shortcut and is stopped.',
        expected:
          'A red alert quotes the server: the action requires a reviewer, and the status has not moved.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the reviewer sends it back for rework', async () => {
      const page = await as('reviewer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Return for rework');
      await workbench.expectStatus('Review returned');

      await recorder.capture(page, {
        id: 'reviewer-returns-for-rework',
        title: 'The reviewer is not satisfied',
        actor: 'reviewer',
        transition: 'UNDER_REVIEW --RETURN--> REVIEW_RETURNED',
        kind: 'transition',
        description:
          'A review that can only say yes is not a review. The reviewer returns the case to the ' +
          'assessor, and the return is recorded as its own event rather than as a silent ' +
          'reversal, so that a case reworked three times reads differently from one accepted ' +
          'first time.',
        expected: 'The status reads Review returned and the case is back with the assessor.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor resumes, recalculates and resubmits', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Resume preparation');
      await workbench.expectStatus('In preparation');

      await recorder.capture(page, {
        id: 'resume-preparation',
        title: 'The assessor picks the returned case back up',
        actor: 'assessor',
        transition: 'REVIEW_RETURNED --START--> IN_PREPARATION',
        kind: 'transition',
        description:
          'A returned case goes back to preparation rather than to a special rework state, ' +
          'because the work is the same work. The history keeps the loop visible, so the second ' +
          'submission is plainly a second submission.',
        expected: 'The status reads In preparation again, with the earlier adjustment still there.',
        statusAfter: await workbench.status(),
      });

      await workbench.calculate();
      await workbench.expectStatus('Calculated');

      await recorder.capture(page, {
        id: 'recalculate',
        title: 'The liability is computed again',
        actor: 'assessor',
        transition: 'IN_PREPARATION --CALCULATE--> CALCULATED',
        kind: 'transition',
        description:
          'Recalculating supersedes the previous result rather than editing it. The earlier ' +
          'figures stay in the record with their own trace, because a case that was once ' +
          'assessed at a different number is a fact an appeal may turn on.',
        expected: 'The status reads Calculated and a current result carries a fresh trace.',
        statusAfter: await workbench.status(),
      });

      await workbench.act('Submit for review');
      await workbench.expectStatus('Under review');

      await recorder.capture(page, {
        id: 'resubmit-for-review',
        title: 'The reworked assessment goes back to the reviewer',
        actor: 'assessor',
        transition: 'CALCULATED --SUBMIT--> UNDER_REVIEW',
        kind: 'transition',
        description:
          'The same transition as the first submission, driven a second time. The loop back ' +
          'through review is the ordinary shape of this work rather than an exception, and the ' +
          'state machine models it as one.',
        expected: 'The status reads Under review for the second time in this history.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the reviewer accepts', async () => {
      const page = await as('reviewer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Accept');
      await workbench.expectStatus('Reviewed');

      await recorder.capture(page, {
        id: 'reviewer-accepts',
        title: 'The reviewer accepts the reworked assessment',
        actor: 'reviewer',
        transition: 'UNDER_REVIEW --ACCEPT--> REVIEWED',
        kind: 'transition',
        description:
          'The reviewer is satisfied with the figures and the reasons given for them. Acceptance ' +
          'is a personal act attributed to a named officer, and it is the last point at which ' +
          'the assessment can be changed quietly.',
        expected: 'The status reads Reviewed.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('approval is routed by the amount, not by the caller', async () => {
      const page = await as('reviewer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Route for approval');
      await workbench.expectStatus('Pending approval');

      // Scoped to the action bar's own card. The tab below it carries muted
      // explanatory prose of its own, and the last one on the page is that.
      const actions = page
        .locator('.tas-card')
        .filter({ has: page.getByText('Actions') })
        .first();
      await expect(actions.locator('.tas-muted')).toContainText(/band/i, { timeout: 20_000 });

      await recorder.capture(page, {
        id: 'route-for-approval',
        title: 'The platform decides who must approve',
        actor: 'reviewer',
        transition: 'REVIEWED --ROUTE_APPROVAL--> PENDING_APPROVAL',
        kind: 'transition',
        description:
          'Nobody chooses their own approver. The reviewer asks for routing and the platform ' +
          'matches the assessed amount against the configured delegation bands, then states in ' +
          'a sentence how it decided. That sentence is the answer to "why has this landed on me".',
        expected:
          'The status reads Pending approval and the screen names the band the amount fell into.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor is never offered approval', async () => {
      const page = await as('assessor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      // Not merely hidden. The API refuses it too; the screen agreeing with
      // the server is what stops officers learning to expect errors.
      await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);

      await recorder.capture(page, {
        id: 'assessor-not-offered-approve',
        title: 'The action bar offers the assessor nothing',
        actor: 'assessor',
        transition: null,
        kind: 'refusal',
        description:
          'The assessor opens the case waiting for approval and finds no Approve button. The ' +
          'server would refuse the action in any event; hiding it is a courtesy so that an ' +
          'officer is not invited to press something that will be denied.',
        expected: 'No control labelled Approve exists anywhere on the assessor’s view of the case.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('a taxpayer is refused the officer route outright', async () => {
      const register = await apiStatus('acme-finance', '/cases');
      const thisCase = await apiStatus('acme-finance', `/cases/${caseId}`);

      // 403 and not 401: the taxpayer is authenticated and simply may not.
      expect(register, 'the officer register refuses a taxpayer').toBe(403);
      expect(thisCase, 'a taxpayer cannot open the workbench for any case').toBe(403);

      const page = await as('acme-finance');
      await page.goto('/portal');
      await expect(page.locator('h1')).toContainText(/tax affairs/i, { timeout: 20_000 });

      await recorder.capture(page, {
        id: 'taxpayer-refused-officer-route',
        title: 'The taxpayer sees their own affairs and nothing else',
        actor: 'acme-finance',
        transition: null,
        kind: 'refusal',
        description:
          'A taxpayer signs in and gets the portal. Asked directly for the officer register and ' +
          'for this case, the server answers 403 to both, so the separation holds even for ' +
          'somebody who types the address by hand rather than following a menu. The screenshot ' +
          'shows what they do get: their own position, in plain words.',
        expected:
          'GET /cases and GET /cases/{id} both return 403 for the taxpayer, while the portal loads.',
        statusAfter: null,
      });
    });

    await test.step('an approver approves', async () => {
      const page = await as('approver');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Approve');
      await workbench.expectStatus('Approved');

      await recorder.capture(page, {
        id: 'approve',
        title: 'The assessment is approved',
        actor: 'approver',
        transition: 'PENDING_APPROVAL --APPROVE--> APPROVED',
        kind: 'transition',
        description:
          'An approver holding the delegation the amount requires signs the assessment off. ' +
          'This is the authority deciding, as an institution, that the figure is right. What ' +
          'follows is about giving it legal effect rather than about arriving at it.',
        expected: 'The status reads Approved and the action bar is empty.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('a notice cannot be issued before finalisation', async () => {
      const page = await as('notice-issuer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Notices');

      await page.getByRole('button', { name: 'Issue notice' }).click();
      await expect(page.locator('.tas-alert--danger').first()).toContainText(/finalised/i, {
        timeout: 20_000,
      });

      await recorder.capture(page, {
        id: 'notice-refused-before-finalisation',
        title: 'An approved assessment is not yet a determination',
        actor: 'notice-issuer',
        transition: null,
        kind: 'refusal',
        description:
          'The notice issuer tries to issue the assessment notice on the approved case and is ' +
          'refused. A notice gives legal effect to a determination, so it may only be issued ' +
          'from a finalised one. Finalisation is the point of no return: it consumes the losses ' +
          'the calculation relied on and stops the figures being recomputed.',
        expected:
          'A red alert quotes the server: the notice may only be issued once the assessment is finalised.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('finalisation turns out to have no screen', async () => {
      const before = await apiGet<{ statusCode: string }>('supervisor', `/cases/${caseId}`);
      expect(
        before.statusCode,
        'nothing in the application or the process definition finalises an approved case',
      ).toBe('APPROVED');

      await finaliseOutsideTheUi(caseId);

      const page = await as('approver');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.expectStatus('Finalised');

      await recorder.capture(page, {
        id: 'finalisation-has-no-screen',
        title: 'A gap: nothing an officer can press finalises a case',
        actor: 'approver',
        transition: null,
        kind: 'observation',
        description:
          'APPROVED to FINALISED is the only move in this journey that no officer can make. The ' +
          'API grants POST /cases/{id}/finalise to approvers and supervisors, the web ' +
          'application calls it from nowhere, and the process definition has no step for it ' +
          'either, so an approved case stops dead. This run called that endpoint directly to ' +
          'reach the stages after it; the transition is deliberately left unrecorded, because ' +
          'no screen drove it and the coverage matrix should say so.',
        expected:
          'The case was APPROVED before the call and reads Finalised after it, with no control on any screen that performs it.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the notice issuer issues the notice', async () => {
      const page = await as('notice-issuer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Notices');

      await page.getByRole('button', { name: 'Issue notice' }).click();
      await workbench.expectStatus('Notice generated');

      await expect(page.getByRole('button', { name: 'Serve' })).toBeVisible({ timeout: 20_000 });

      await recorder.capture(page, {
        id: 'issue-notice',
        title: 'The determination is written into a notice',
        actor: 'notice-issuer',
        transition: 'FINALISED --GENERATE_NOTICE--> NOTICE_GENERATED',
        kind: 'transition',
        description:
          'The notice issuer renders the assessment notice from the configured template and the ' +
          'finalised figures. The document is hashed as it is written, and re-issuing produces ' +
          'a new version rather than editing the old one, because the taxpayer may be holding ' +
          'the old one. The case moves on as a consequence of the notice existing, which is why ' +
          'the transition belongs to SYSTEM rather than to the officer.',
        expected: 'The status reads Notice generated and a numbered, versioned notice is listed.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the notice is proved unaltered', async () => {
      const page = await as('notice-issuer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Notices');

      await page.getByRole('button', { name: 'Verify' }).first().click();
      await expect(page.locator('.tas-alert').filter({ hasText: 'Unaltered' })).toBeVisible({
        timeout: 20_000,
      });

      await recorder.capture(page, {
        id: 'verify-notice',
        title: 'The notice still says what it said when issued',
        actor: 'notice-issuer',
        transition: null,
        kind: 'observation',
        description:
          'Verification recomputes the hash from the stored text and compares it with the one ' +
          'recorded at issue. It is a button rather than a badge because the question is asked ' +
          'at a particular moment, usually in a dispute, and an automatic green tick on every ' +
          'page load is a check nobody reads.',
        expected: 'The screen reports Unaltered and prints the stored and recomputed hashes.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the notice is served on the taxpayer', async () => {
      const page = await as('notice-issuer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Notices');

      await page.getByLabel('Channel').selectOption('EMAIL');
      await page.getByLabel('Addressee').fill('finance@acme.example.com');
      await page.getByLabel('Proof reference').fill('MSG-E2E-0001');
      await page.getByRole('button', { name: 'Serve' }).click();

      await expect(page.locator('table.tas-table tbody tr').first()).toBeVisible({
        timeout: 20_000,
      });

      await recorder.capture(page, {
        id: 'serve-notice',
        title: 'The notice is despatched, and the clock starts',
        actor: 'notice-issuer',
        transition: 'NOTICE_GENERATED --SERVED--> NOTICE_SERVED',
        kind: 'transition',
        description:
          'The officer records a despatch: the channel, who it went to, and the proof reference ' +
          'they can produce later. Each attempt is its own row with its own outcome, because ' +
          'service by post that comes back and service by email that does not are different ' +
          'facts. The deemed service date, not the despatch date, is what the objection window ' +
          'runs from. The status badge skips straight past Notice served because the same act ' +
          'opens the response window, which the next step shows.',
        expected:
          'A service attempt is listed with its channel, addressee and deemed service date, and the case is served.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the objection window opens on its own', async () => {
      const page = await as('notice-issuer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.expectStatus('Awaiting taxpayer response');
      await workbench.tab('Deadlines & SLA');

      await recorder.capture(page, {
        id: 'response-window-open',
        title: 'The taxpayer now has a window to object',
        actor: 'system',
        transition: 'NOTICE_SERVED --START_RESPONSE_WINDOW--> AWAITING_TAXPAYER_RESPONSE',
        kind: 'transition',
        description:
          'The same act that recorded service opened the response window, and materialised the ' +
          "objection deadline from the deemed service date under the jurisdiction's calendar " +
          'rules. No officer presses a button called this, and none should: the window is a ' +
          'consequence of service in law, not a decision anybody takes.',
        expected:
          'The status reads Awaiting taxpayer response and a dated objection deadline is listed with how it was derived.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('an objection is filed against the assessment', async () => {
      const page = await as('objection-officer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Disputes');

      await page
        .locator('#obj-summary')
        .fill('The third-party revenue figure double counts intra-group sales already declared.');
      await page.locator('#obj-ground').fill('FACTUAL_ERROR');
      await page.locator('#obj-disputed').fill('40000.00');
      await page.locator('#obj-channel').selectOption('POST');
      await page.getByRole('button', { name: 'File objection' }).click();

      await workbench.expectStatus('Under objection');

      await recorder.capture(page, {
        id: 'file-objection',
        title: 'The taxpayer disputes the assessment',
        actor: 'objection-officer',
        transition: 'AWAITING_TAXPAYER_RESPONSE --FILE_OBJECTION--> UNDER_OBJECTION',
        kind: 'transition',
        description:
          "An objection arrives by post and an officer records it on the taxpayer's behalf, " +
          'which is how most of them arrive. It must state at least one ground and may name the ' +
          'amount in dispute. The platform accepts it even out of time and computes the lateness ' +
          'separately, because refusing at the door would deny a discretion the law gives to a ' +
          'person.',
        expected:
          'The status reads Under objection and the objection is listed with its number and whether it was in time.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the officer rules the objection admissible', async () => {
      const page = await as('objection-officer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Disputes');

      await page.getByRole('button', { name: 'Work it' }).first().click();
      await page
        .locator('#adm-reason')
        .fill('Filed in time, grounds are stated with enough particularity to be answered.');
      await page.getByRole('button', { name: 'Admit', exact: true }).click();

      await expect(page.getByRole('button', { name: 'Decide' })).toBeVisible({ timeout: 20_000 });

      await recorder.capture(page, {
        id: 'admit-objection',
        title: 'Whether to hear it is decided before what to decide',
        actor: 'objection-officer',
        transition: null,
        kind: 'observation',
        description:
          'Admissibility is ruled on first and separately from the merits, and the ruling must ' +
          'give a reason. Refusing to hear somebody is the decision most likely to be ' +
          'challenged, so the platform will not let it be made silently. The case status does ' +
          'not move: the objection is admitted, the dispute is still open.',
        expected:
          'The objection reads as admitted and the merits panel, with its opinion and decision controls, appears.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the deposit position is stated', async () => {
      const page = await as('objection-officer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Disputes');
      await page.getByRole('button', { name: 'Work it' }).first().click();

      const deposit = page.locator('.tas-alert').filter({ hasText: 'Deposit' }).first();
      await expect(deposit).toBeVisible({ timeout: 20_000 });
      const position = await deposit.innerText();

      // Whether a deposit is due is configuration, not a property of this
      // case, so the step records the answer rather than assuming one.
      if (/outstanding/i.test(position) && !/none required/i.test(position)) {
        await deposit.locator('input').fill('1000.00');
        await page.getByRole('button', { name: 'Record deposit' }).click();
        await expect(deposit).toContainText(/paid/i, { timeout: 20_000 });
      }

      await recorder.capture(page, {
        id: 'deposit-position',
        title: 'What the taxpayer must pay to be heard',
        actor: 'objection-officer',
        transition: null,
        kind: 'observation',
        description:
          'Some jurisdictions require part of the disputed tax to be deposited before an ' +
          'objection is heard. The panel states the position and the arithmetic behind it, ' +
          'including any floor or cap, and any payment received is recorded against it. An ' +
          'unpaid deposit does not make the objection inadmissible; that stays a decision for a ' +
          'person.',
        expected:
          'The deposit panel states either the amount required with its derivation, or that none is required here.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('an opinion is recorded before the decision', async () => {
      const page = await as('objection-officer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Disputes');
      await page.getByRole('button', { name: 'Work it' }).first().click();

      const opinionRow = page
        .locator('.tas-row')
        .filter({ has: page.getByRole('button', { name: 'Record my opinion' }) });
      await opinionRow.locator('select').selectOption('REJECT');
      await page.getByRole('button', { name: 'Record my opinion' }).click();

      await expect(page.getByText('Panel opinions')).toBeVisible({ timeout: 20_000 });

      await recorder.capture(page, {
        id: 'panel-opinion',
        title: 'The people who considered it say what they thought',
        actor: 'objection-officer',
        transition: null,
        kind: 'observation',
        description:
          'Opinions are recorded against named people and kept whatever the decision turns out ' +
          "to be. The decision is the deciding officer's and is not a tally of the votes, but a " +
          'decision that goes against the opinions is logged as such, because that is precisely ' +
          'the one somebody will later be asked to justify.',
        expected: 'The objection lists the opinion against the officer who gave it.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the objection is decided', async () => {
      const page = await as('objection-officer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Disputes');
      await page.getByRole('button', { name: 'Work it' }).first().click();

      await page
        .locator('#dec-reason')
        .fill(
          'The intra-group sales were not declared on the return; the third-party figure stands.',
        );
      const decisionRow = page
        .locator('.tas-row')
        .filter({ has: page.getByRole('button', { name: 'Decide' }) });
      await decisionRow.locator('select').selectOption('REJECTED');
      await page.getByRole('button', { name: 'Decide' }).click();

      await workbench.expectStatus('Objection rejected');

      await recorder.capture(page, {
        id: 'decide-objection',
        title: 'The objection is rejected, with reasons',
        actor: 'objection-officer',
        transition: 'UNDER_OBJECTION --DECIDE_REJECTED--> OBJECTION_REJECTED',
        kind: 'transition',
        description:
          'The officer rejects the objection and must say why. The server refuses a decision ' +
          'with no reasons: a decision the taxpayer cannot understand is a decision they cannot ' +
          'appeal against intelligibly, and in most jurisdictions that is itself a ground of ' +
          'appeal. Rejection opens the appeal window and leaves the assessment standing.',
        expected:
          'The status reads Objection rejected and the decision is shown with the reasons given for it.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('reassessment is refused while the dispute route is still open', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Closure');

      await page
        .locator('#re-grounds')
        .fill('Reopening the period on the strength of the rejected objection.');
      await page.getByRole('button', { name: 'Open reassessment' }).click();

      await expect(page.locator('.tas-alert--danger').first()).toBeVisible({ timeout: 20_000 });

      await recorder.capture(page, {
        id: 'reassessment-refused-on-rejection',
        title: 'The status decides the shape, not the officer',
        actor: 'supervisor',
        transition: null,
        kind: 'refusal',
        description:
          'There is one reassessment button and no dropdown asking which kind. A rejected ' +
          'objection leaves the assessment intact, so there is nothing to reassess and the ' +
          'server says so. Offering the choice would invite an officer to pick the shape that is ' +
          'not legally available.',
        expected:
          'A red alert explains that a reassessment follows a dispute outcome or a closed case.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the taxpayer appeals to a tribunal', async () => {
      const page = await as('appeals-officer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Disputes');

      await page.locator('#app-forum').fill('FIRST_TIER_TRIBUNAL');
      await page.locator('#app-ref').fill('FTT/2026/00417');
      await page
        .locator('#app-grounds')
        .fill('The rejection of the objection did not address the intra-group evidence supplied.');
      await page.getByRole('button', { name: 'File appeal' }).click();

      await workbench.expectStatus('Under appeal');

      await recorder.capture(page, {
        id: 'file-appeal',
        title: 'The dispute leaves the authority',
        actor: 'appeals-officer',
        transition: 'OBJECTION_REJECTED --FILE_APPEAL--> UNDER_APPEAL',
        kind: 'transition',
        description:
          'Having been rejected inside the authority, the taxpayer appeals to a tribunal. The ' +
          "forum must be one the jurisdiction recognises, and the forum's own reference is " +
          'captured, because that number is the only thing tying the two files together when ' +
          'the tribunal writes back.',
        expected:
          'The status reads Under appeal and the appeal is listed with its forum and reference.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the tribunal sets the assessment aside', async () => {
      const appeals = await apiGet<{ uuid: string }[]>('supervisor', `/cases/${caseId}/appeals`);
      expect(appeals.length, 'the appeal was recorded against the case').toBe(1);

      const page = await as('appeals-officer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Disputes');

      // The screen asks for the appeal's uuid and shows only its number, so
      // the identifier is read from the API rather than transcribed. That is
      // a wart on the screen, not a shortcut around it: the outcome itself is
      // recorded by filling this form and pressing the button.
      const outcomeRow = page
        .locator('.tas-row')
        .filter({ has: page.getByPlaceholder('Appeal uuid') });
      await outcomeRow.locator('select').selectOption('SET_ASIDE');
      await page.getByPlaceholder('Appeal uuid').fill(appeals[0]!.uuid);
      await page
        .locator('#app-outcome-reason')
        .fill('The tribunal held the third-party figure unsupported and set the assessment aside.');
      await page.getByRole('button', { name: 'Record outcome' }).click();

      await workbench.expectStatus('Appeal set aside');

      await recorder.capture(page, {
        id: 'record-appeal-outcome',
        title: 'What the tribunal held is transcribed, not decided',
        actor: 'appeals-officer',
        transition: 'UNDER_APPEAL --RECORD_SET_ASIDE--> APPEAL_SET_ASIDE',
        kind: 'transition',
        description:
          'There is no approve button anywhere on this panel. An appeal is decided by a forum ' +
          'outside the authority, so the officer is transcribing a judgment and must record the ' +
          "forum's reasons with it. Setting an assessment aside removes it, which is why the " +
          'case can now only be closed rather than reassessed.',
        expected:
          'The status reads Appeal set aside and the outcome is listed against the appeal with its reasons.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the supervisor closes the case', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Closure');

      await page.locator('#close-reason').fill('DISPUTE_EXHAUSTED');
      await page.locator('#close-retention').selectOption('STATUTORY');
      await page
        .locator('#close-narrative')
        .fill('Assessment set aside on appeal. No further route open to either party.');
      await page.getByRole('button', { name: 'Close case' }).click();

      await workbench.expectStatus('Closed');

      await recorder.capture(page, {
        id: 'close-case',
        title: 'The file is closed and the final position frozen',
        actor: 'supervisor',
        transition: 'APPEAL_SET_ASIDE --CLOSE--> CLOSED',
        kind: 'transition',
        description:
          'Closing snapshots what was assessed, what was paid and what is left, under a reason ' +
          'code the jurisdiction configures. The balance is stored rather than recomputed on ' +
          'later reads, because the file has to keep saying what it said at the time. The ' +
          'retention class sets when it may be destroyed.',
        expected:
          'The status reads Closed and the closure record shows the reason, the frozen balance and the retention date.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the ledger holds every movement', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Timeline');

      const rows = page.locator('.tas-card table tbody tr');
      await expect(rows.first()).toBeVisible({ timeout: 20_000 });
      expect(await rows.count(), 'the case history is complete').toBeGreaterThanOrEqual(12);

      await recorder.capture(page, {
        id: 'timeline-ledger',
        title: 'Everything that happened, in order, unalterable',
        actor: 'supervisor',
        transition: null,
        kind: 'observation',
        description:
          'Every act in this document is an event in the ledger: who did it, when, and what the ' +
          'case looked like afterwards. The tables behind it are append-only, enforced by a ' +
          'database trigger rather than by a permission, so no update or delete can reach them ' +
          'from any code path. This is the record an audit reads.',
        expected: 'The timeline lists at least twelve events, covering opening through closure.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the process shows where the case went', async () => {
      const page = await as('supervisor');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Journey');

      await expect(page.getByText('Process journey')).toBeVisible({ timeout: 20_000 });

      await recorder.capture(page, {
        id: 'journey',
        title: 'The same history, against the process it followed',
        actor: 'supervisor',
        transition: null,
        kind: 'observation',
        description:
          'The journey tab draws the deployed process definition and marks what has finished ' +
          'and what is waiting. A case with no process instance is a normal answer rather than ' +
          'an error: orchestration never fails a case, and one opened while the engine was ' +
          'unreachable is worked perfectly well by hand.',
        expected:
          'The journey tab states either the instance and its position, or that no process is coordinating the case.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('cancelling a case opened in error turns out to be unreachable', async () => {
      const page = await as('supervisor');
      const opened = await Workbench.openCase(page, { year: await freeAssessmentYear() });
      const workbench = new Workbench(page);

      // The engine refreshes evidence within a second of a case opening, so
      // INITIATED, the only state the table allows CANCEL from, is gone
      // before the workbench has finished loading. Racing it would buy a
      // flaky test rather than coverage.
      await workbench.expectStatus('Data ready');
      await workbench.actAndExpectRefusal('Cancel', /No transition defined from DATA_READY/i);
      await workbench.expectStatus('Data ready');

      await recorder.capture(page, {
        id: 'cancel-offered-but-not-defined',
        title: 'A gap: the only state a case can be cancelled from lasts about a second',
        actor: 'supervisor',
        transition: null,
        kind: 'refusal',
        description:
          `A supervisor opens case ${opened.caseNumber} on a throwaway year and tries to cancel ` +
          'it straight away. The button is there and the server refuses it: the transition table ' +
          'allows CANCEL from INITIATED only, and the process engine had already moved the case ' +
          'to DATA_READY by the time the screen finished loading. The action bar and the state ' +
          'machine disagree, and the officer gets the error rather than the courtesy.',
        expected:
          'The server answers "No transition defined from DATA_READY on action CANCEL", and the case is still Data ready.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor asks the taxpayer for information', async () => {
      const supervisor = await as('supervisor');
      const assessor = await as('assessor');
      const parked = await prepareThrowawayCase(supervisor, assessor);

      const workbench = new Workbench(assessor);
      await workbench.act('Request information');
      await workbench.expectStatus('Awaiting taxpayer');

      await recorder.capture(assessor, {
        id: 'request-information',
        title: 'The case is parked on the taxpayer',
        actor: 'assessor',
        transition: 'IN_PREPARATION --REQUEST_INFO--> AWAITING_TAXPAYER',
        kind: 'transition',
        description:
          `Case ${parked.caseNumber} needs something only the taxpayer holds, so the assessor ` +
          'asks for it and the case stops. The separate state matters for measurement: time ' +
          'spent waiting on a taxpayer is not time the authority took, and a service standard ' +
          'that counted it would be measuring the wrong thing.',
        expected: 'The status reads Awaiting taxpayer.',
        statusAfter: await workbench.status(),
      });

      const reviewer = await as('reviewer');
      await reviewer.goto(parked.url);
      const reviewerBench = new Workbench(reviewer);
      await reviewerBench.actAndExpectRefusal(
        'Record a response',
        /TA_TAXPAYER|TA_ASSESSOR|TA_SUPERVISOR/i,
      );
      await reviewerBench.expectStatus('Awaiting taxpayer');

      await recorder.capture(reviewer, {
        id: 'respond-refused-to-reviewer',
        title: 'A reviewer may not record the response',
        actor: 'reviewer',
        transition: null,
        kind: 'refusal',
        description:
          'Recording what a taxpayer sent back belongs to the officer who asked for it and to ' +
          'their supervisor. A reviewer checks the finished assessment and has no business ' +
          'entering evidence into it, so the server refuses and names the roles that may.',
        expected:
          'A red alert names the permitted actors, and the status is still Awaiting taxpayer.',
        statusAfter: await reviewerBench.status(),
      });

      await workbench.act('Record a response');
      await workbench.expectStatus('In preparation');

      await recorder.capture(assessor, {
        id: 'record-taxpayer-response',
        title: 'The assessor records what the taxpayer sent back',
        actor: 'assessor',
        transition: 'AWAITING_TAXPAYER --RESPOND--> IN_PREPARATION',
        kind: 'transition',
        description:
          'Replies arrive by post, by email and over a counter, so the response is the ' +
          "taxpayer's act and rarely their keystroke. The assessor who asked for the " +
          'information records what came back and the case returns to preparation. Who ' +
          'responded is captured on the audit payload rather than inferred from who typed.',
        expected: 'The status returns to In preparation and the ledger records INFO_RECEIVED.',
        statusAfter: await workbench.status(),
      });
    });
  });
});
