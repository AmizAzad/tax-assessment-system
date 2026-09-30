import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { QueryTypes, Sequelize } from 'sequelize';
import { EvidenceRecorder } from './support/evidence';
import {
  apiAttempt,
  apiGet,
  apiStatus,
  apiToken,
  demoTaxpayer,
  expect,
  freeAssessmentYear,
  test,
  type Role,
} from './support/fixtures';
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
 * screen of their own. Where a screen drives one as a side effect of a real
 * act, that is recorded as a transition and the description says so: serving a
 * notice opens the response window, a payment settles the case, a decided
 * objection reassesses it.
 *
 * Nothing here moves a case by writing its status. Every transition was
 * reached by an officer pressing a control, by a service drawing a conclusion
 * from figures somebody entered, or by the deadline sweep running its own
 * code. Where a branch had to have its ground prepared first -- an account
 * entry in the wrong currency, a deadline dated in the past -- the step that
 * needed it says so in its own description, because arranging the facts a
 * transition reacts to is a different thing from faking the transition.
 *
 * ## Why the branches run on their own cases
 *
 * A lifecycle branches, and most of its branches end. A case that is
 * cancelled, written off, settled or closed cannot also go on to be objected
 * to and appealed, and `REQUEST_INFO` parks a case on a taxpayer who cannot
 * reach the workbench. So the main case carries the ordinary history from
 * opening to closure, and every other branch gets a case of its own, walked
 * through the same screens to the point where it diverges and photographed
 * from there.
 */

const API = process.env['E2E_API'] ?? 'http://localhost:3000';

let recorder: EvidenceRecorder;

/** A case under test, and the three facts every later step needs to find it. */
interface CaseUnderTest {
  readonly id: number;
  readonly url: string;
  readonly caseNumber: string;
}

/** The officers a branch needs. `committee-member` and the taxpayer act only on the main case. */
type Officer =
  | 'supervisor'
  | 'assessor'
  | 'reviewer'
  | 'approver'
  | 'notice-issuer'
  | 'objection-officer'
  | 'appeals-officer';

/**
 * One signed-in page per officer, opened once and navigated thereafter.
 *
 * The main journey opens a fresh browser context for every step, which reads
 * well and costs little over one case. The branches drive ten more cases
 * through the same dozen screens each, and a context per step would be several
 * hundred of them. The saved session is injected before any script runs and
 * survives navigation, so an officer reusing a tab exercises exactly what an
 * officer opening one does.
 */
type Cast = Readonly<Record<Officer, Page>>;

const CAST_LIST: readonly Officer[] = [
  'supervisor',
  'assessor',
  'reviewer',
  'approver',
  'notice-issuer',
  'objection-officer',
  'appeals-officer',
];

async function assembleCast(as: (role: Role) => Promise<Page>): Promise<Cast> {
  const pages: Partial<Record<Officer, Page>> = {};
  for (const officer of CAST_LIST) {
    pages[officer] = await as(officer);
  }
  return pages as Cast;
}

function caseFrom(opened: { url: string; caseNumber: string }): CaseUnderTest {
  const id = Number(/\/cases\/(\d+)$/.exec(opened.url)?.[1]);
  expect(Number.isInteger(id), 'the register navigated into a numbered case').toBe(true);
  return { id, url: opened.url, caseNumber: opened.caseNumber };
}

/** Put an officer in front of a case and hand back its workbench. */
async function workbenchFor(cast: Cast, officer: Officer, c: CaseUnderTest): Promise<Workbench> {
  await cast[officer].goto(c.url);
  return new Workbench(cast[officer]);
}

/** Today, as the date inputs and the account endpoint both want it. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Arrange something the API owns. Never the act under test. */
async function apiPost(role: Role, path: string, body: unknown): Promise<number> {
  const token = await apiToken(role);
  const response = await fetch(`${API}/api/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} as ${role}: HTTP ${response.status} ${await response.text()}`);
  }
  return response.status;
}

/** Open a case and take it to preparation. The preamble every branch shares. */
async function prepareCase(cast: Cast): Promise<CaseUnderTest> {
  const opened = await Workbench.openCase(cast.supervisor, {
    taxpayerId: (await demoTaxpayer()).taxpayerId,
    year: await freeAssessmentYear(),
  });
  const c = caseFrom(opened);

  const supervisor = new Workbench(cast.supervisor);
  if ((await supervisor.status()) !== 'Data ready') {
    await supervisor.retrieveEvidence();
  }
  await supervisor.expectStatus('Data ready');

  await cast.supervisor.locator('#assignee').fill('assessor');
  await supervisor.act('Assign');
  await supervisor.expectStatus('Assigned');

  const assessor = await workbenchFor(cast, 'assessor', c);
  await assessor.act('Start preparation');
  await assessor.expectStatus('In preparation');

  return c;
}

/** Adjust if asked, calculate, review and route. Ends at PENDING_APPROVAL. */
async function routeForApproval(
  cast: Cast,
  c: CaseUnderTest,
  options: { adjust: boolean },
): Promise<void> {
  const assessor = await workbenchFor(cast, 'assessor', c);
  if (options.adjust) {
    await assessor.addAdjustment({
      type: 'UNDERSTATED_REVENUE',
      reason: 'THIRD_PARTY_MISMATCH',
      amount: '40000.00',
      direction: 'ADD',
      narrative: 'Third-party data shows revenue the return does not account for.',
    });
  }
  await assessor.calculate();
  await assessor.expectStatus('Calculated');
  await assessor.act('Submit for review');
  await assessor.expectStatus('Under review');

  const reviewer = await workbenchFor(cast, 'reviewer', c);
  await reviewer.act('Accept');
  await reviewer.expectStatus('Reviewed');
  await reviewer.act('Route for approval');
  await reviewer.expectStatus('Pending approval');
}

/** Approve, finalise, issue and serve. Ends at AWAITING_TAXPAYER_RESPONSE. */
async function serveTheNotice(cast: Cast, c: CaseUnderTest): Promise<void> {
  const approver = await workbenchFor(cast, 'approver', c);
  await approver.act('Approve');
  await approver.expectStatus('Approved');
  await approver.act('Finalise');
  await approver.expectStatus('Finalised');

  const issuer = cast['notice-issuer'];
  const issuerBench = await workbenchFor(cast, 'notice-issuer', c);
  await issuerBench.tab('Notices');
  await issuer.getByRole('button', { name: 'Issue notice' }).click();
  await issuerBench.expectStatus('Notice generated');

  await issuer.goto(c.url);
  await issuerBench.tab('Notices');
  await issuer.getByLabel('Channel').selectOption('EMAIL');
  await issuer.getByLabel('Addressee').fill('finance@acme.example.com');
  await issuer.getByLabel('Proof reference').fill(`MSG-${c.caseNumber}`);
  await issuer.getByRole('button', { name: 'Serve' }).click();
  await issuerBench.expectStatus('Awaiting taxpayer response');
}

/** File an objection on the taxpayer's behalf and rule it admissible. */
async function fileAndAdmitObjection(cast: Cast, c: CaseUnderTest, summary: string): Promise<void> {
  const officer = cast['objection-officer'];
  const bench = await workbenchFor(cast, 'objection-officer', c);
  await bench.tab('Disputes');

  await officer.locator('#obj-summary').fill(summary);
  await officer.locator('#obj-ground').selectOption('FACTUAL_ERROR');
  await officer.locator('#obj-disputed').fill('40000.00');
  await officer.locator('#obj-channel').selectOption('POST');
  await officer.getByRole('button', { name: 'File objection' }).click();
  await bench.expectStatus('Under objection');

  await officer.goto(c.url);
  await bench.tab('Disputes');
  await officer.getByRole('button', { name: 'Work it' }).first().click();
  await officer
    .locator('#adm-reason')
    .fill('Filed in time, and the grounds are particularised enough to be answered.');
  await officer.getByRole('button', { name: 'Admit', exact: true }).click();
  await expect(officer.getByRole('button', { name: 'Decide' })).toBeVisible({ timeout: 20_000 });
}

/** Decide an admitted objection on its merits. */
async function decideObjection(
  cast: Cast,
  c: CaseUnderTest,
  decision: 'ALLOWED' | 'PARTLY_ALLOWED' | 'REJECTED',
  reason: string,
): Promise<void> {
  const officer = cast['objection-officer'];
  const bench = await workbenchFor(cast, 'objection-officer', c);
  await bench.tab('Disputes');
  await officer.getByRole('button', { name: 'Work it' }).first().click();

  await officer.locator('#dec-reason').fill(reason);
  const row = officer
    .locator('.tas-row')
    .filter({ has: officer.getByRole('button', { name: 'Decide' }) });
  await row.locator('select').selectOption(decision);
  await officer.getByRole('button', { name: 'Decide' }).click();
}

/** Record that the taxpayer has taken a rejected objection to a tribunal. */
async function fileAppeal(cast: Cast, c: CaseUnderTest, grounds: string): Promise<void> {
  const officer = cast['appeals-officer'];
  const bench = await workbenchFor(cast, 'appeals-officer', c);
  await bench.tab('Disputes');

  await officer.locator('#app-forum').selectOption('FIRST_TIER_TRIBUNAL');
  await officer.locator('#app-ref').fill(`FTT/2026/${c.caseNumber}`);
  await officer.locator('#app-grounds').fill(grounds);
  await officer.getByRole('button', { name: 'File appeal' }).click();
  await bench.expectStatus('Under appeal');
}

/**
 * Transcribe what the forum held.
 *
 * The appeal is chosen from the case's undecided appeals by its identifier,
 * read from the API only to know which option to pick; the outcome is still
 * recorded by filling this form.
 */
async function recordAppealOutcome(
  cast: Cast,
  c: CaseUnderTest,
  outcome: 'UPHELD' | 'VARIED' | 'REMANDED',
  reason: string,
): Promise<void> {
  const appeals = await apiGet<{ uuid: string }[]>('supervisor', `/cases/${c.id}/appeals`);
  expect(appeals.length, 'the appeal was recorded against the case').toBe(1);

  const officer = cast['appeals-officer'];
  const bench = await workbenchFor(cast, 'appeals-officer', c);
  await bench.tab('Disputes');

  await officer.locator('#app-outcome-appeal').selectOption(appeals[0]!.uuid);
  await officer.locator('#app-outcome').selectOption(outcome);
  await officer.locator('#app-outcome-reason').fill(reason);
  await officer.getByRole('button', { name: 'Record outcome' }).click();
}

/** Ask for a reassessment from the Closure tab. The shape follows the status. */
async function openReassessment(cast: Cast, c: CaseUnderTest, grounds: string): Promise<void> {
  const bench = await workbenchFor(cast, 'supervisor', c);
  await bench.tab('Closure');
  await cast.supervisor.locator('#re-grounds').fill(grounds);
  await cast.supervisor.getByRole('button', { name: 'Open reassessment' }).click();
}

/**
 * Record the money, in the amount the current calculation says is due.
 *
 * The figure is read from the server rather than hard-coded, because the whole
 * point of settlement is that the platform compares what was assessed with
 * what arrived. A hard-coded amount would pass or fail on the rule set rather
 * than on the comparison.
 */
async function recordPayment(cast: Cast, c: CaseUnderTest, reference: string): Promise<string> {
  const current = await apiGet<{ netPayable: string | null }>('supervisor', `/cases/${c.id}`);
  const net = current.netPayable;
  const due = net === null || net.startsWith('-') || /^0+(\.0+)?$/.test(net) ? '1.00' : net;

  const bench = await workbenchFor(cast, 'supervisor', c);
  await bench.tab('Closure');

  await cast.supervisor.locator('#pay-type').selectOption('PAYMENT');
  await cast.supervisor.locator('#pay-amount').fill(due);
  await cast.supervisor.locator('#pay-date').fill(today());
  await cast.supervisor.locator('#pay-reference').fill(reference);
  await cast.supervisor.getByRole('button', { name: 'Record payment' }).click();

  return due;
}

/** Close a case from the Closure tab under a configured reason code. */
async function closeCase(
  cast: Cast,
  c: CaseUnderTest,
  reasonCode: string,
  narrative: string,
): Promise<void> {
  const bench = await workbenchFor(cast, 'supervisor', c);
  await bench.tab('Closure');
  await cast.supervisor.locator('#close-reason').selectOption(reasonCode);
  await cast.supervisor.locator('#close-retention').selectOption('STATUTORY');
  await cast.supervisor.locator('#close-narrative').fill(narrative);
  await cast.supervisor.getByRole('button', { name: 'Close case' }).click();
}

/** One connection, opened for an arrangement and closed after it. */
async function withDatabase<T>(work: (db: Sequelize) => Promise<T>): Promise<T> {
  const db = new Sequelize(
    process.env['DB_NAME'] ?? 'tax_assessment',
    process.env['DB_USER'] ?? 'tas',
    process.env['DB_PASSWORD'] ?? 'tas_local_dev_only',
    {
      host: process.env['DB_HOST'] ?? 'localhost',
      port: Number(process.env['DB_PORT'] ?? '5433'),
      dialect: 'postgres',
      logging: false,
    },
  );
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}

/**
 * Put an objection deadline in the past.
 *
 * Arrangement, and the only part of the window-lapsed branch that is. Nothing
 * an officer can reach sets this date: it is derived from the deemed service
 * date, and service is always recorded as of now. So the row is edited
 * directly, which changes a fact the sweep reacts to and changes no status.
 * The lapse itself is still performed by the shipped sweep.
 */
async function backdateTheObjectionDeadline(caseId: number): Promise<number> {
  return withDatabase(async (db) => {
    const [, affected] = await db.query(
      `UPDATE tax.tax_assessment_deadline
          SET due_at = CURRENT_DATE - INTERVAL '2 days', updated_at = CURRENT_TIMESTAMP
        WHERE case_id = :caseId AND deadline_type = 'OBJECTION' AND is_active`,
      { type: QueryTypes.UPDATE, replacements: { caseId } },
    );
    return affected ?? 0;
  });
}

/** The GB CIT response window, as `tax.tax_deadline_config` states it. */
interface ResponseWindow {
  readonly offsetValue: number;
  readonly offsetUnit: string;
  readonly calendarRule: string;
}

/**
 * A response window that was already spent when it opened.
 *
 * The engine fixes the boundary timer's instant when the information request
 * is made, from the `RESPONSE` deadline the API materialises at that moment,
 * so a row edited afterwards moves nothing. The configuration has to be wrong
 * for the length of one click, and is put back in the same step.
 *
 * `CALENDAR_DAYS` rather than the shipped `NEXT_BUSINESS_DAY`, because rolling
 * a negative offset forward to the next working day can land the due date on
 * today, and the timer fires at the midnight that ends the due date. Ten days
 * back lands the instant in the past whatever day of the week the run happens
 * on.
 */
const AN_ELAPSED_RESPONSE_WINDOW: ResponseWindow = {
  offsetValue: -10,
  offsetUnit: 'DAYS',
  calendarRule: 'CALENDAR_DAYS',
};

async function readTheResponseWindow(): Promise<ResponseWindow> {
  return withDatabase(async (db) => {
    const rows = await db.query<ResponseWindow>(
      `SELECT offset_value AS "offsetValue", offset_unit AS "offsetUnit",
              calendar_rule AS "calendarRule"
         FROM tax.tax_deadline_config
        WHERE jurisdiction_code = 'GB' AND tax_type_code = 'CIT'
          AND deadline_type = 'RESPONSE' AND is_active`,
      { type: QueryTypes.SELECT },
    );
    expect(rows.length, 'GB CIT configures exactly one response window').toBe(1);
    return rows[0]!;
  });
}

async function writeTheResponseWindow(window: ResponseWindow): Promise<void> {
  await withDatabase(async (db) => {
    await db.query(
      `UPDATE tax.tax_deadline_config
          SET offset_value = :offsetValue, offset_unit = :offsetUnit,
              calendar_rule = :calendarRule, updated_at = CURRENT_TIMESTAMP
        WHERE jurisdiction_code = 'GB' AND tax_type_code = 'CIT'
          AND deadline_type = 'RESPONSE' AND is_active`,
      { type: QueryTypes.UPDATE, replacements: { ...window } },
    );
  });
}

/**
 * Record a limitation date that has already passed, against cases that are open.
 *
 * Arrangement, and it has to be an insert. The sweep acts on a materialised
 * `LIMITATION` deadline row rather than on the case's limitation date, and no
 * jurisdiction shipped today configures a `LIMITATION` deadline type, so there
 * is no configuration for `DeadlineService.materialise` to work from and no
 * screen that writes one. The row goes in `OPEN` and dated two days back, which
 * is what the sweep's ordinary `markBreached` pass reacts to; the time bar is
 * then applied by the sweep from the breached row, not by this function.
 */
async function recordALapsedLimitationDeadline(caseIds: readonly number[]): Promise<number> {
  return withDatabase(async (db) => {
    let written = 0;
    for (const caseId of caseIds) {
      const rows = await db.query<{ id: string }>(
        `INSERT INTO tax.tax_assessment_deadline
                (case_id, deadline_type, anchor_event, anchor_at, due_at, status,
                 created_at, updated_at, is_active)
         VALUES (:caseId, 'LIMITATION', 'PERIOD_END', CURRENT_DATE - INTERVAL '5 years',
                 CURRENT_DATE - INTERVAL '2 days', 'OPEN',
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true)
         RETURNING id::text AS id`,
        { type: QueryTypes.SELECT, replacements: { caseId } },
      );
      written += rows.length;
    }
    return written;
  });
}

/**
 * The deadline sweep, in the scheduler's own code, in a process of its own.
 *
 * `DeadlineScheduler.sweep` is reachable from an hourly `@Cron` and from
 * nothing else: the API publishes no route that runs it and there is no
 * command for it. Waiting up to an hour inside a test is not an option, and
 * writing the status from SQL would not be the sweep at all. So the run boots
 * the worker's own dependency graph in a short-lived process and calls the
 * method the cron calls. The SELECT, the cross-replica job lock and the SYSTEM
 * transition are all the shipped ones.
 *
 * The `@tas/*` hook stands in for the path mapping the TypeScript build uses.
 * The workspace packages emit to `dist/src` and their `main` does not say so,
 * which only matters when something loads the built output directly, as here.
 */
const SWEEP_IN_A_CHILD_PROCESS = `
const Module = require('module');
const path = require('path');
const fs = require('fs');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@tas/')) {
    const built = path.join(process.cwd(), 'packages', request.slice(5), 'dist', 'src', 'index.js');
    if (fs.existsSync(built)) return built;
  }
  return resolveFilename.call(this, request, ...rest);
};
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { WorkerModule } = require('./apps/worker/dist/worker/src/worker.module.js');
const scheduler = require('./apps/worker/dist/api/src/tax-assessment/deadline/deadline.scheduler.js');
NestFactory.createApplicationContext(WorkerModule, { logger: ['error'] })
  .then(async (context) => {
    await context.get(scheduler.DeadlineScheduler, { strict: false }).sweep();
    await context.close();
    console.log('SWEEP_COMPLETED');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
`;

/**
 * `settings` reach the child and nothing else. `TIME_BAR_ON_LIMITATION_EXPIRY`
 * is off by default and stays off for the deployment, the API and every other
 * step: an authority turns it on deliberately, and so does one step of this
 * run.
 */
function runTheDeadlineSweep(settings: Readonly<Record<string, string>> = {}): string {
  const built = join(process.cwd(), 'apps', 'worker', 'dist', 'worker', 'src', 'worker.module.js');
  if (!existsSync(built)) {
    throw new Error(
      `The worker build is missing at ${built}. Run \`npm run build --workspace @tas/worker\` ` +
        'first: this step runs the shipped scheduler rather than a copy of it.',
    );
  }
  return execFileSync(process.execPath, ['-e', SWEEP_IN_A_CHILD_PROCESS], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ...settings },
  });
}

test.describe('a documented assessment', () => {
  test.beforeAll(() => {
    EvidenceRecorder.reset();
    recorder = new EvidenceRecorder();
  });

  test('runs from initiation to closure, and says what it could not drive', async ({ as }) => {
    // Fifteen cases, nine officers, four disputes, two deadline sweeps and an
    // engine timer. The suite-wide 60 second budget is for a single stage, not
    // for a whole register's worth of case histories.
    test.setTimeout(3_600_000);

    let caseUrl = '';
    let caseNumber = '';
    let caseId = 0;

    await test.step('a supervisor opens the case', async () => {
      const page = await as('supervisor');
      const opened = await Workbench.openCase(page, {
        taxpayerId: (await demoTaxpayer()).taxpayerId,
        year: await freeAssessmentYear(),
      });
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

      await workbench.expectStatus('Under review');
      await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);

      // The screen no longer offers the shortcut, so the attempt is made where
      // somebody determined would make it: straight at the API.
      const refused = await apiAttempt('assessor', `/cases/${caseId}/transition`, {
        action: 'ACCEPT',
      });
      expect(refused.status, 'the server refuses the assessor their own review').toBe(403);
      expect(refused.message).toMatch(/TA_REVIEWER|reviewer|not the assessor/i);
      await page.reload();
      await workbench.expectStatus('Under review');

      await recorder.capture(page, {
        id: 'assessor-refused-own-review',
        title: 'The assessor cannot accept their own work',
        actor: 'assessor',
        transition: null,
        kind: 'refusal',
        description:
          'The assessor opens the case they just wrote and is offered no Accept. Trying it ' +
          'anyway, straight at the API, is refused with a message naming the role that may act: ' +
          `"${refused.message}". Segregation of duties is only visible when somebody tries the ` +
          'shortcut and is stopped.',
        expected:
          'No Accept button for the assessor, the API answers 403 naming the reviewer, and the status has not moved.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the reviewer sends it back for rework', async () => {
      const page = await as('reviewer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await expect(
        page.getByRole('button', { name: 'Return for rework', exact: true }),
        'the return will not fire until the reviewer has said what is wrong',
      ).toBeDisabled();
      await page
        .locator('#transition-reason')
        .fill(
          'The disallowed entertaining is not evidenced. Attach the invoices before resubmitting.',
        );

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
          'first time. The button stays dead until the reviewer types what is wrong, because a ' +
          'return the assessor cannot act on is a round trip for nothing.',
        expected:
          'Return for rework is disabled while the reason is empty; once it is given the status reads Review returned and the case is back with the assessor.',
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

      await expect(workbench.actionNote()).toContainText(/band/i, { timeout: 20_000 });

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

      // Drawn from the loaded case, so asserting an absence before it loads
      // would pass on an empty page.
      await workbench.expectStatus('Pending approval');

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

      // The tab says when a notice becomes possible instead of offering one
      // the server would refuse; the refusal is asserted at the API.
      await expect(page.getByRole('button', { name: 'Issue notice' })).toHaveCount(0);
      await expect(page.locator('.tas-card').filter({ hasText: 'Notices' }).first()).toContainText(
        /finalised/i,
      );
      const refused = await apiAttempt('notice-issuer', `/cases/${caseId}/notices`, {
        noticeType: 'ASSESSMENT',
      });
      expect(refused.status, 'the server refuses a notice before finalisation').toBe(409);
      expect(refused.message).toMatch(/finalis/i);

      await recorder.capture(page, {
        id: 'notice-refused-before-finalisation',
        title: 'An approved assessment is not yet a determination',
        actor: 'notice-issuer',
        transition: null,
        kind: 'refusal',
        description:
          'The notice issuer opens the approved case and is told a notice can be issued once the ' +
          'assessment is finalised; trying anyway at the API is refused. A notice gives legal ' +
          'effect to a determination, so it may only be issued ' +
          'from a finalised one. Finalisation is the point of no return: it consumes the losses ' +
          'the calculation relied on and stops the figures being recomputed.',
        expected:
          'No Issue notice button, the tab says it waits for finalisation, and the API refuses with 409.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the approver finalises the determination', async () => {
      const before = await apiGet<{ statusCode: string }>('supervisor', `/cases/${caseId}`);
      expect(before.statusCode, 'the case is approved and not yet final').toBe('APPROVED');

      const page = await as('approver');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);

      await workbench.act('Finalise');
      await workbench.expectStatus('Finalised');

      await recorder.capture(page, {
        id: 'finalise',
        title: 'The approved figure becomes a determination',
        actor: 'approver',
        transition: 'APPROVED --FINALISE--> FINALISED',
        kind: 'transition',
        description:
          'The approver presses Finalise. This is the point of no return: finalising consumes ' +
          'the brought-forward losses the calculation relied on, so those losses are spent ' +
          'against this year and cannot be spent again, and the figures stop being ' +
          'recomputable. It is a second, deliberate act rather than a consequence of approval ' +
          'because approving says the number is right and finalising says the authority is now ' +
          'standing on it.',
        expected:
          'The status reads Finalised, and the action bar empties because a finalised case ' +
          'offers no further lifecycle action.',
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
      await page.locator('#obj-ground').selectOption('FACTUAL_ERROR');
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

      // The tab does not offer a reassessment the status cannot take; the
      // server's refusal is asserted at the API.
      await expect(page.getByRole('button', { name: 'Open reassessment' })).toHaveCount(0);
      const refused = await apiAttempt('supervisor', `/cases/${caseId}/reassess`, {
        grounds: 'Reopening the period on the strength of the rejected objection.',
      });
      expect(refused.status, 'the server refuses a reassessment on a rejected objection').toBe(409);

      await recorder.capture(page, {
        id: 'reassessment-refused-on-rejection',
        title: 'The status decides the shape, not the officer',
        actor: 'supervisor',
        transition: null,
        kind: 'refusal',
        description:
          'There is no reassessment to open here, and no dropdown asking which kind. A rejected ' +
          'objection leaves the assessment intact, so there is nothing to reassess; the tab says ' +
          `so, and the server refuses the attempt: "${refused.message}". Offering the choice would ` +
          'invite an officer to pick the shape that is not legally available.',
        expected:
          'No Open reassessment button on a rejected objection, and the API refuses with 409.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the taxpayer appeals to a tribunal', async () => {
      const page = await as('appeals-officer');
      await page.goto(caseUrl);
      const workbench = new Workbench(page);
      await workbench.tab('Disputes');

      await page.locator('#app-forum').selectOption('FIRST_TIER_TRIBUNAL');
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

      // The appeal is picked from the case's undecided appeals; its
      // identifier is read from the API only to know which option to choose.
      await page.locator('#app-outcome-appeal').selectOption(appeals[0]!.uuid);
      await page.locator('#app-outcome').selectOption('SET_ASIDE');
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

      await page.locator('#close-reason').selectOption('DISPUTE_EXHAUSTED');
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

    const cast = await assembleCast(as);

    await test.step('the action bar offers a cancel the state machine will not allow', async () => {
      const page = cast.supervisor;
      const opened = await Workbench.openCase(page, {
        taxpayerId: (await demoTaxpayer()).taxpayerId,
        year: await freeAssessmentYear(),
      });
      const workbench = new Workbench(page);

      // The engine refreshes evidence within a second of a case opening, so a
      // case whose sources all answer is past INITIATED before the workbench
      // has finished loading. Racing it would buy a flaky test rather than
      // coverage; the branch that follows holds a case at INITIATED honestly.
      await workbench.expectStatus('Data ready');
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Assign', exact: true })).toBeVisible();

      await recorder.capture(page, {
        id: 'cancel-not-offered-once-workable',
        title: 'The action bar offers only what the case can actually do',
        actor: 'supervisor',
        transition: null,
        kind: 'observation',
        description:
          `A supervisor opens case ${opened.caseNumber} on a throwaway year and the engine has ` +
          'already gathered its evidence. Cancellation belongs to a case that never became ' +
          'workable, so the bar offers Assign and nothing else. The screen used to offer Cancel ' +
          'here and the server refused it every time, which taught officers to expect errors ' +
          'from buttons that look available.',
        expected:
          'No Cancel button is present on a Data ready case, and Assign is offered instead.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('a case that never became workable is cancelled', async () => {
      const year = await freeAssessmentYear();

      // Arrangement, stated because it matters: the taxpayer's account for
      // this period is given a euro entry, which makes the mandatory
      // TAXPAYER_ACCOUNT source refuse to answer a sterling case rather than
      // silently convert it. The case therefore stays at INITIATED instead of
      // being carried to DATA_READY a second after it opens, which is the only
      // state CANCEL is permitted from.
      await apiPost('supervisor', `/taxpayers/${(await demoTaxpayer()).taxpayerId}/account`, {
        entryType: 'ADVANCE_PAYMENT',
        taxTypeCode: 'CIT',
        assessmentYear: year,
        amount: '250.00',
        currencyCode: 'EUR',
        valueDate: today(),
        sourceReference: `E2E-EUR-${year}`,
        narrative: 'Seeded in euro so the account source cannot answer a sterling case.',
      });

      const opened = await Workbench.openCase(cast.supervisor, {
        taxpayerId: (await demoTaxpayer()).taxpayerId,
        year,
      });
      const stuck = caseFrom(opened);
      const workbench = new Workbench(cast.supervisor);
      await workbench.expectStatus('Initiated');

      // Pressed by hand rather than left to the engine's callback, because the
      // failure panel reports the retrieval this officer asked for. Waiting on
      // somebody else's retrieval would photograph an empty tab.
      await workbench.retrieveEvidence();
      await expect(
        cast.supervisor.locator('.tas-alert--danger').filter({ hasText: 'Case not advanced' }),
      ).toContainText(/currency translation is not automatic/i, { timeout: 20_000 });
      await workbench.expectStatus('Initiated');

      await recorder.capture(cast.supervisor, {
        id: 'held-at-initiated',
        title: 'A mandatory source that cannot answer holds the case at the door',
        actor: 'supervisor',
        transition: null,
        kind: 'observation',
        description:
          `Case ${stuck.caseNumber} opens against a taxpayer whose account for this period holds ` +
          'euro entries while the case is assessed in sterling. The account source refuses ' +
          'rather than converting, because an exchange rate buried inside evidence retrieval is ' +
          'one nobody would ever find again. It is a mandatory source, so the case does not ' +
          'become workable and sits at Initiated.',
        expected:
          'The retrieval panel reads "Case not advanced", lists TAXPAYER_ACCOUNT as a mandatory source that failed on the currency mismatch, and the status is still Initiated.',
        statusAfter: await workbench.status(),
      });

      await expect(
        cast.supervisor.getByRole('button', { name: 'Cancel', exact: true }),
        'the cancellation will not fire until the supervisor has said why',
      ).toBeDisabled();
      await cast.supervisor
        .locator('#transition-reason')
        .fill('Opened in error: the taxpayer has no sterling obligation for this period.');

      await workbench.act('Cancel');
      await workbench.expectStatus('Cancelled');

      await recorder.capture(cast.supervisor, {
        id: 'cancel-case',
        title: 'A case opened in error is cancelled outright',
        actor: 'supervisor',
        transition: 'INITIATED --CANCEL--> CANCELLED',
        kind: 'transition',
        description:
          'A supervisor cancels the case. Cancellation is permitted only before any evidence has ' +
          'been gathered on it, which is why the window is so narrow: once the authority has ' +
          "pulled a taxpayer's data it has acted, and the file has to be closed with a reason " +
          'rather than made to disappear. Cancelling is terminal and leaves the period free for ' +
          'a fresh case. The control will not fire without a reason typed next to it.',
        expected:
          'Cancel is disabled while the reason is empty; once it is given the status reads Cancelled and the action bar is gone entirely.',
        statusAfter: await workbench.status(),
      });
    });

    await test.step('the assessor asks the taxpayer for information', async () => {
      const assessor = cast.assessor;
      const parked = await prepareCase(cast);

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
      await reviewerBench.expectStatus('Awaiting taxpayer');
      await expect(
        reviewer.getByRole('button', { name: 'Record a response', exact: true }),
      ).toHaveCount(0);
      const refused = await apiAttempt('reviewer', `/cases/${parked.id}/transition`, {
        action: 'RESPOND',
      });
      expect(refused.status, 'the server refuses a reviewer the response').toBe(403);
      expect(refused.message).toMatch(/TA_TAXPAYER|TA_ASSESSOR|TA_SUPERVISOR/i);

      await recorder.capture(reviewer, {
        id: 'respond-refused-to-reviewer',
        title: 'A reviewer may not record the response',
        actor: 'reviewer',
        transition: null,
        kind: 'refusal',
        description:
          'Recording what a taxpayer sent back belongs to the officer who asked for it and to ' +
          'their supervisor. A reviewer checks the finished assessment and has no business ' +
          'entering evidence into it, so the screen does not offer it and the server refuses ' +
          `the attempt, naming the roles that may: "${refused.message}".`,
        expected:
          'No Record a response button for the reviewer, the API answers 403, and the status is still Awaiting taxpayer.',
        statusAfter: await reviewerBench.status(),
      });

      await assessor.goto(parked.url);
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

    let rejected: CaseUnderTest;

    await test.step('an approver refuses to sign the assessment off', async () => {
      rejected = await prepareCase(cast);
      await routeForApproval(cast, rejected, { adjust: true });

      const approver = await workbenchFor(cast, 'approver', rejected);
      await expect(
        cast.approver.getByRole('button', { name: 'Reject', exact: true }),
        'the rejection will not fire until the approver has said why they will not sign',
      ).toBeDisabled();
      await cast.approver
        .locator('#transition-reason')
        .fill('The transfer pricing adjustment cites no comparables and no statutory reference.');

      await approver.act('Reject');
      await approver.expectStatus('Rejected');

      await recorder.capture(cast.approver, {
        id: 'approver-rejects',
        title: 'Approval is a decision, so it can go the other way',
        actor: 'approver',
        transition: 'PENDING_APPROVAL --REJECT--> REJECTED',
        kind: 'transition',
        description:
          `Case ${rejected.caseNumber} reaches an approver who is not satisfied with it. ` +
          'Rejection is a distinct state rather than a quiet bounce back to preparation, because ' +
          'an assessment an approver declined to sign is a different fact from one still being ' +
          'written, and a case rejected twice has to read differently from one approved first ' +
          'time. The approver has to say why: the assessor who picks the case back up is ' +
          'entitled to know what to change.',
        expected:
          'Reject is disabled while the reason is empty; once it is given the status reads Rejected and the only action now offered is Rework.',
        statusAfter: await approver.status(),
      });

      const assessor = await workbenchFor(cast, 'assessor', rejected);
      await assessor.act('Rework');
      await assessor.expectStatus('In preparation');

      await recorder.capture(cast.assessor, {
        id: 'rework-after-rejection',
        title: 'The assessor takes the rejected assessment back',
        actor: 'assessor',
        transition: 'REJECTED --START--> IN_PREPARATION',
        kind: 'transition',
        description:
          'A rejected case returns to the same preparation state a returned review does, and by ' +
          'the same action, because the work is the same work. What distinguishes the two is the ' +
          'history rather than a bespoke state: the ledger holds who rejected it and why, and ' +
          'the next submission is plainly a resubmission.',
        expected:
          'The status reads In preparation and the bar offers the assessor the work again rather than a fresh case.',
        statusAfter: await assessor.status(),
      });
    });

    await test.step('a debt nobody will collect is written off', async () => {
      await routeForApproval(cast, rejected, { adjust: false });
      await serveTheNotice(cast, rejected);

      const supervisor = await workbenchFor(cast, 'supervisor', rejected);
      await supervisor.expectStatus('Awaiting taxpayer response');
      await expect(
        cast.supervisor.getByRole('button', { name: 'Write off', exact: true }),
        'the write-off will not fire until the supervisor has said on whose judgement',
      ).toBeDisabled();
      await cast.supervisor
        .locator('#transition-reason')
        .fill('Company dissolved; no assets and no successor to pursue.');
      await supervisor.act('Write off');
      await supervisor.expectStatus('Written off');
      await supervisor.tab('Timeline');

      await recorder.capture(cast.supervisor, {
        id: 'write-off',
        title: 'The authority gives up on money it is owed',
        actor: 'supervisor',
        transition: 'AWAITING_TAXPAYER_RESPONSE --WRITE_OFF--> WRITTEN_OFF',
        kind: 'transition',
        description:
          `The notice on case ${rejected.caseNumber} was served and nothing came back, and the ` +
          'company behind it no longer exists. A supervisor abandons the debt. The control is ' +
          'styled as a destructive one and will not fire without a reason typed next to it, ' +
          'because the file has to record on whose judgement the money stopped being owed. ' +
          'Writing off is terminal.',
        expected:
          'The status reads Written off and the newest row of the case history moves it there from Awaiting taxpayer response, carrying the reason the supervisor typed.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('an objection is allowed, and the case is assessed again', async () => {
      const allowed = await prepareCase(cast);
      await routeForApproval(cast, allowed, { adjust: true });
      await serveTheNotice(cast, allowed);
      await fileAndAdmitObjection(
        cast,
        allowed,
        'The third-party revenue figure is the same intra-group sales already declared on the return.',
      );
      await decideObjection(
        cast,
        allowed,
        'ALLOWED',
        'The invoices supplied match the declared sales line for line. The adjustment falls away.',
      );

      const officer = new Workbench(cast['objection-officer']);
      await officer.expectStatus('Objection allowed');

      await recorder.capture(cast['objection-officer'], {
        id: 'objection-allowed',
        title: 'The authority finds against itself',
        actor: 'objection-officer',
        transition: 'UNDER_OBJECTION --DECIDE_ALLOWED--> OBJECTION_ALLOWED',
        kind: 'transition',
        description:
          'The objection officer accepts the taxpayer’s case in full and must say why, as with ' +
          'any other decision. Allowing an objection does not by itself change the figures: it ' +
          'establishes that they are wrong, and the correction is a separate act with its own ' +
          'record, so that what was decided and what was done about it can be read apart.',
        expected:
          'The status reads Objection allowed and the decision is listed with the reasons given for it.',
        statusAfter: await officer.status(),
      });

      await openReassessment(
        cast,
        allowed,
        'The objection was allowed in full; the understated revenue adjustment is withdrawn.',
      );
      const supervisor = new Workbench(cast.supervisor);
      await supervisor.expectStatus('Reassessment initiated');

      await recorder.capture(cast.supervisor, {
        id: 'reassess-after-objection-allowed',
        title: 'The correction is opened on the same case',
        actor: 'supervisor',
        transition: 'OBJECTION_ALLOWED --REASSESS--> REASSESSMENT_INITIATED',
        kind: 'transition',
        description:
          'There is one reassessment control and no dropdown asking which kind. Because this ' +
          'case carries a dispute outcome, the platform continues the same case rather than ' +
          'opening a successor, and it records the grounds and whether the reassessment reaches ' +
          'past the limitation date. The move belongs to SYSTEM: it follows from the decision ' +
          'already recorded, not from a fresh judgement by the officer who asked for it.',
        expected:
          'The status reads Reassessment initiated and the reassessment is listed with its shape, trigger and grounds.',
        statusAfter: await supervisor.status(),
      });

      const assessor = await workbenchFor(cast, 'assessor', allowed);
      await assessor.act('Start preparation');
      await assessor.expectStatus('In preparation');

      await recorder.capture(cast.assessor, {
        id: 'start-reassessment',
        title: 'The reassessment is picked up like any other work',
        actor: 'assessor',
        transition: 'REASSESSMENT_INITIATED --START--> IN_PREPARATION',
        kind: 'transition',
        description:
          'An assessor takes the reassessment up and it re-enters the ordinary path: prepare, ' +
          'calculate, review, approve. Nothing about a case having been disputed lets it skip ' +
          'the controls, and the corrected figure will be reviewed by somebody other than the ' +
          'officer who produces it exactly as the first one was.',
        expected:
          'The status reads In preparation and the bar offers the ordinary preparation actions, on the same case number as before.',
        statusAfter: await assessor.status(),
      });
    });

    await test.step('an objection is allowed in part', async () => {
      const partly = await prepareCase(cast);
      await routeForApproval(cast, partly, { adjust: true });
      await serveTheNotice(cast, partly);
      await fileAndAdmitObjection(
        cast,
        partly,
        'Part of the third-party revenue figure is intra-group; the remainder is accepted.',
      );
      await decideObjection(
        cast,
        partly,
        'PARTLY_ALLOWED',
        'Half the disputed sales are evidenced as intra-group. The balance stands unexplained.',
      );

      const officer = new Workbench(cast['objection-officer']);
      await officer.expectStatus('Objection partly allowed');

      await recorder.capture(cast['objection-officer'], {
        id: 'objection-partly-allowed',
        title: 'Most disputes end somewhere in the middle',
        actor: 'objection-officer',
        transition: 'UNDER_OBJECTION --DECIDE_PARTLY_ALLOWED--> OBJECTION_PARTLY_ALLOWED',
        kind: 'transition',
        description:
          'A partial outcome is its own state rather than a note on an allowance, because what ' +
          'happens next differs: the assessment is neither withdrawn nor left standing, and the ' +
          'appeal rights that follow are calculated against a figure that has moved. Each ground ' +
          'can carry its own outcome, so the taxpayer can see which of their arguments landed.',
        expected:
          'The status reads Objection partly allowed and the decision is listed with its reasons.',
        statusAfter: await officer.status(),
      });

      await openReassessment(
        cast,
        partly,
        'The objection was partly allowed; the revenue adjustment is reduced to the unexplained balance.',
      );
      const supervisor = new Workbench(cast.supervisor);
      await supervisor.expectStatus('Reassessment initiated');

      await recorder.capture(cast.supervisor, {
        id: 'reassess-after-objection-partly-allowed',
        title: 'A partial outcome reopens the same case',
        actor: 'supervisor',
        transition: 'OBJECTION_PARTLY_ALLOWED --REASSESS--> REASSESSMENT_INITIATED',
        kind: 'transition',
        description:
          'The same control, the same shape, a different starting status. A partly allowed ' +
          'objection leaves an assessment that is wrong in a known way, so the case is ' +
          'reassessed in place and the earlier calculation is superseded rather than edited. ' +
          'Both figures stay on the file, because which number was demanded when is a fact an ' +
          'appeal can turn on.',
        expected:
          'The status reads Reassessment initiated and the reassessment records the grounds for reopening.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('a rejected objection that is never appealed is closed', async () => {
      const unappealed = await prepareCase(cast);
      await routeForApproval(cast, unappealed, { adjust: true });
      await serveTheNotice(cast, unappealed);
      await fileAndAdmitObjection(
        cast,
        unappealed,
        'The taxpayer disputes the revenue adjustment but supplies nothing new in support.',
      );
      await decideObjection(
        cast,
        unappealed,
        'REJECTED',
        'No evidence was supplied beyond the assertion. The third-party figure stands.',
      );

      const officer = new Workbench(cast['objection-officer']);
      await officer.expectStatus('Objection rejected');

      await closeCase(
        cast,
        unappealed,
        'DISPUTE_EXHAUSTED',
        'Objection rejected and the appeal window closed without an appeal being lodged.',
      );
      const supervisor = new Workbench(cast.supervisor);
      await supervisor.expectStatus('Closed');

      await recorder.capture(cast.supervisor, {
        id: 'close-after-objection-rejected',
        title: 'The other end of a rejected objection',
        actor: 'supervisor',
        transition: 'OBJECTION_REJECTED --CLOSE--> CLOSED',
        kind: 'transition',
        description:
          `The objection on case ${unappealed.caseNumber} was rejected and the appeal window ran ` +
          'out without an appeal. The main case in this document took the other road and went to ' +
          'a tribunal; this one simply ends. Closing freezes what was assessed, what was paid ' +
          'and what is left under a reason code the jurisdiction configures, and sets the date ' +
          'the file may be destroyed.',
        expected:
          'The status reads Closed and the closure record shows Dispute exhausted, the frozen balance and the retention date.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('a tribunal varies the assessment', async () => {
      const varied = await prepareCase(cast);
      await routeForApproval(cast, varied, { adjust: true });
      await serveTheNotice(cast, varied);
      await fileAndAdmitObjection(
        cast,
        varied,
        'The revenue adjustment is disputed in full on the intra-group point.',
      );
      await decideObjection(
        cast,
        varied,
        'REJECTED',
        'The intra-group point was not made out on the material supplied.',
      );
      await fileAppeal(
        cast,
        varied,
        'The rejection did not engage with the reconciliation the taxpayer supplied.',
      );
      await recordAppealOutcome(
        cast,
        varied,
        'VARIED',
        'The tribunal accepted part of the reconciliation and reduced the adjustment accordingly.',
      );

      const officer = new Workbench(cast['appeals-officer']);
      await officer.expectStatus('Appeal varied');

      await recorder.capture(cast['appeals-officer'], {
        id: 'appeal-varied',
        title: 'The tribunal changes the figure rather than the principle',
        actor: 'appeals-officer',
        transition: 'UNDER_APPEAL --RECORD_VARIED--> APPEAL_VARIED',
        kind: 'transition',
        description:
          'There is no approve control on this panel. An appeal is decided by a forum outside ' +
          'the authority, so the officer transcribes a judgment and must record the reasons ' +
          'given for it. A variation leaves the assessment alive at a different number, which is ' +
          'why the case can be reassessed rather than only closed.',
        expected:
          'The status reads Appeal varied and the appeal is listed as Decided against its forum and reference, with outcome VARIED.',
        statusAfter: await officer.status(),
      });

      await openReassessment(
        cast,
        varied,
        'Giving effect to the tribunal decision varying the revenue adjustment.',
      );
      const supervisor = new Workbench(cast.supervisor);
      await supervisor.expectStatus('Reassessment initiated');

      await recorder.capture(cast.supervisor, {
        id: 'reassess-after-appeal-varied',
        title: 'Giving effect to what the tribunal held',
        actor: 'supervisor',
        transition: 'APPEAL_VARIED --REASSESS--> REASSESSMENT_INITIATED',
        kind: 'transition',
        description:
          'Recording an outcome and giving effect to it are two acts, and the gap between them ' +
          'is what an authority gets asked about. The reassessment is what implements the ' +
          'decision, and its trigger is recorded as an appeal decision rather than as an ' +
          'objection, so a report can tell which forum caused which correction.',
        expected:
          'The status reads Reassessment initiated and the reassessment is triggered by the appeal decision.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('a tribunal sends the assessment back to be done again', async () => {
      const remanded = await prepareCase(cast);
      await routeForApproval(cast, remanded, { adjust: true });
      await serveTheNotice(cast, remanded);
      await fileAndAdmitObjection(
        cast,
        remanded,
        'The taxpayer says the objection was decided without the documents being read.',
      );
      await decideObjection(
        cast,
        remanded,
        'REJECTED',
        'The adjustment is maintained on the third-party data.',
      );
      await fileAppeal(
        cast,
        remanded,
        'The authority decided the objection without considering the bundle that was lodged with it.',
      );
      await recordAppealOutcome(
        cast,
        remanded,
        'REMANDED',
        'The tribunal made no finding on the figures and remitted the matter to be reconsidered.',
      );

      const officer = new Workbench(cast['appeals-officer']);
      await officer.expectStatus('Appeal remanded');

      await recorder.capture(cast['appeals-officer'], {
        id: 'appeal-remanded',
        title: 'The tribunal declines to decide and sends it back',
        actor: 'appeals-officer',
        transition: 'UNDER_APPEAL --RECORD_REMANDED--> APPEAL_REMANDED',
        kind: 'transition',
        description:
          'A remittal is not a win for either side. The forum has held that the authority did ' +
          'not decide the matter properly and must do it again, so the assessment is neither ' +
          'upheld nor set aside. Modelling it as its own outcome keeps that distinction: a case ' +
          'remitted for reconsideration reads nothing like one the tribunal decided on its ' +
          'merits.',
        expected:
          'The status reads Appeal remanded and the appeal is listed as Decided against its forum and reference, with outcome REMANDED.',
        statusAfter: await officer.status(),
      });

      await openReassessment(
        cast,
        remanded,
        'Reconsidering the assessment as the tribunal directed, on the bundle previously lodged.',
      );
      const supervisor = new Workbench(cast.supervisor);
      await supervisor.expectStatus('Reassessment initiated');

      await recorder.capture(cast.supervisor, {
        id: 'reassess-after-appeal-remanded',
        title: 'Doing it again, as directed',
        actor: 'supervisor',
        transition: 'APPEAL_REMANDED --REASSESS--> REASSESSMENT_INITIATED',
        kind: 'transition',
        description:
          'The remittal reopens the same case rather than opening a successor, because the ' +
          'period was never finally determined. The grounds recorded here are the direction the ' +
          'tribunal gave, so the reason the authority is looking at this period a second time is ' +
          'on the file rather than in somebody’s memory.',
        expected:
          'The status reads Reassessment initiated and the grounds record the tribunal’s direction.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('a taxpayer loses an appeal and then pays', async () => {
      const upheld = await prepareCase(cast);
      await routeForApproval(cast, upheld, { adjust: true });
      await serveTheNotice(cast, upheld);
      await fileAndAdmitObjection(
        cast,
        upheld,
        'The revenue adjustment is disputed on the ground that the sales were intra-group.',
      );
      await decideObjection(
        cast,
        upheld,
        'REJECTED',
        'The sales were not shown to be intra-group. The adjustment is maintained.',
      );
      await fileAppeal(cast, upheld, 'The objection decision misread the third-party data.');
      await recordAppealOutcome(
        cast,
        upheld,
        'UPHELD',
        'The tribunal found the third-party data reliable and upheld the assessment in full.',
      );

      const officer = new Workbench(cast['appeals-officer']);
      await officer.expectStatus('Appeal upheld');

      await recorder.capture(cast['appeals-officer'], {
        id: 'appeal-upheld',
        title: 'The assessment survives the tribunal',
        actor: 'appeals-officer',
        transition: 'UNDER_APPEAL --RECORD_UPHELD--> APPEAL_UPHELD',
        kind: 'transition',
        description:
          'The forum upholds the assessment, so the figure stands and the money is due. Nothing ' +
          'needs correcting, which is why this outcome leads to payment rather than to a ' +
          'reassessment. The officer records the reasons all the same, because an upheld ' +
          'assessment is the one a taxpayer is most likely to take further.',
        expected:
          'The status reads Appeal upheld and the appeal is listed as Decided against its forum and reference, with outcome UPHELD.',
        statusAfter: await officer.status(),
      });

      const paid = await recordPayment(cast, upheld, `BACS-${upheld.caseNumber}`);
      const supervisor = new Workbench(cast.supervisor);
      await supervisor.expectStatus('Settled');

      await recorder.capture(cast.supervisor, {
        id: 'settle-after-appeal-upheld',
        title: 'The money arrives after the appeal is lost',
        actor: 'system (settlement service)',
        transition: 'APPEAL_UPHELD --PAYMENT_SETTLED--> SETTLED',
        kind: 'transition',
        description:
          `A supervisor records ${paid} received against the taxpayer's account for this period, ` +
          'with its bank reference and value date. Nobody presses a control called settled: the ' +
          'platform compares what the current calculation assessed against what has arrived ' +
          'since, and draws the conclusion itself. A button would let a case be marked paid ' +
          'without the money, which is the most damaging false record a revenue system can hold.',
        expected:
          'The status reads Settled and the screen shows the assessed figure, the amount received since the calculation, and nothing outstanding.',
        statusAfter: await supervisor.status(),
      });

      await closeCase(
        cast,
        upheld,
        'SETTLED_IN_FULL',
        'Appeal upheld and the assessed amount paid in full. Nothing further is due either way.',
      );
      await supervisor.expectStatus('Closed');

      await recorder.capture(cast.supervisor, {
        id: 'close-after-settlement',
        title: 'A paid case is closed and its position frozen',
        actor: 'supervisor',
        transition: 'SETTLED --CLOSE--> CLOSED',
        kind: 'transition',
        description:
          'Settlement says the money arrived; closure says the authority is finished with the ' +
          'file. They are separate because a settled case can still have work on it, and ' +
          'because the closing balance is snapshotted rather than recomputed on every later ' +
          'read. The file has to keep saying what it said at the time, whatever later payments ' +
          'or corrections do to the account.',
        expected:
          'The status reads Closed and the closure record shows Settled in full with the frozen assessed, paid and balance figures.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('a served notice is simply paid', async () => {
      const settled = await prepareCase(cast);
      await routeForApproval(cast, settled, { adjust: true });
      await serveTheNotice(cast, settled);

      const paid = await recordPayment(cast, settled, `BACS-${settled.caseNumber}`);
      const supervisor = new Workbench(cast.supervisor);
      await supervisor.expectStatus('Settled');

      await recorder.capture(cast.supervisor, {
        id: 'settle-after-notice-served',
        title: 'The ordinary ending: the taxpayer pays the notice',
        actor: 'system (settlement service)',
        transition: 'AWAITING_TAXPAYER_RESPONSE --PAYMENT_SETTLED--> SETTLED',
        kind: 'transition',
        description:
          `The notice on case ${settled.caseNumber} was served and ${paid} arrived inside the ` +
          'response window. The payment is recorded against the taxpayer’s account for the tax ' +
          'type and year rather than against the case, because that is what a payment is made ' +
          'against, and a period can carry more than one case over its life. Only payments ' +
          'received after the calculation ran count towards it; the earlier ones were already ' +
          'netted off in the figure being demanded. A residue under one unit of currency is ' +
          'treated as settled, because chasing two pence costs more than the two pence.',
        expected:
          'The status reads Settled and the screen shows the assessed figure, what was received since the calculation, and nothing outstanding.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('a response window closes on its own when nobody answers', async () => {
      const ignored = await prepareCase(cast);
      await routeForApproval(cast, ignored, { adjust: true });
      await serveTheNotice(cast, ignored);

      const backdated = await backdateTheObjectionDeadline(ignored.id);
      expect(backdated, 'the objection deadline was moved into the past').toBeGreaterThan(0);

      const output = runTheDeadlineSweep();
      expect(output, 'the sweep ran to completion').toContain('SWEEP_COMPLETED');

      const supervisor = await workbenchFor(cast, 'supervisor', ignored);
      await supervisor.expectStatus('Closed');
      await supervisor.tab('Timeline');

      await recorder.capture(cast.supervisor, {
        id: 'response-window-lapsed',
        title: 'A deadline passing is an event, not an absence',
        actor: 'system (deadline sweep)',
        transition: 'AWAITING_TAXPAYER_RESPONSE --WINDOW_LAPSED--> CLOSED',
        kind: 'transition',
        description:
          `Nobody objected to the notice on case ${ignored.caseNumber} and the window ran out. ` +
          'Storing a due date makes nothing happen when it passes, so a sweep closes the window ' +
          'and the case with it. Two things were arranged for this step and are stated plainly: ' +
          'the objection deadline row was dated two days into the past by a direct update, ' +
          'because no screen back-dates a deemed service date, and the sweep was run in a ' +
          'process of its own because it is reachable only from an hourly cron. The transition ' +
          'itself was performed by the shipped scheduler under a SYSTEM identity, with no ' +
          'status written by this test.',
        expected:
          'The status reads Closed and the newest row of the case history is WINDOW_LAPSED, moving the case from Awaiting taxpayer response to Closed under the sweep’s own reason.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('an information request nobody answers times out on its own', async () => {
      const unanswered = await prepareCase(cast);

      const window = await readTheResponseWindow();
      try {
        await writeTheResponseWindow(AN_ELAPSED_RESPONSE_WINDOW);
        const assessor = new Workbench(cast.assessor);
        await assessor.act('Request information');
        await assessor.expectStatus('Awaiting taxpayer');
      } finally {
        await writeTheResponseWindow(window);
      }
      expect(await readTheResponseWindow(), 'the response window was put back').toEqual(window);

      await expect
        .poll(
          async () =>
            (await apiGet<{ statusCode: string }>('supervisor', `/cases/${unanswered.id}`))
              .statusCode,
          { message: 'the engine timer returned the case to the assessor', timeout: 120_000 },
        )
        .toBe('IN_PREPARATION');

      const supervisor = await workbenchFor(cast, 'supervisor', unanswered);
      await supervisor.expectStatus('In preparation');
      await supervisor.tab('Timeline');

      await recorder.capture(cast.supervisor, {
        id: 'information-request-timed-out',
        title: 'Silence returns the case to the officer who asked',
        actor: 'system (the engine’s boundary timer)',
        transition: 'AWAITING_TAXPAYER --TIMEOUT--> IN_PREPARATION',
        kind: 'transition',
        description:
          `The assessor asked the taxpayer for information on case ${unanswered.caseNumber} and ` +
          'nothing came back. One thing was arranged and is stated plainly: the GB CIT response ' +
          'window is thirty days, which no run can sit through, so its configuration row was set ' +
          'to a period already ten days spent for the moment the request was made and put ' +
          'straight back afterwards, because the engine fixes the timer’s date when the request ' +
          'is made and editing a row later moves nothing. The wait, the timer and the transition ' +
          'are the shipped ones: the process definition parks the case on a receive task and the ' +
          'engine calls the API under its own service account when the window runs out.',
        expected:
          'The status reads In preparation and the newest history row is INFO_TIMEOUT, moving the case from Awaiting taxpayer back to In preparation.',
        statusAfter: await supervisor.status(),
      });
    });

    await test.step('a limitation period runs out on two open cases', async () => {
      const beingPrepared = await prepareCase(cast);

      // The same arrangement the cancelled branch uses, for the same reason: a
      // euro entry on the period makes the mandatory account source refuse a
      // sterling case, which is what holds a case at Initiated long enough for
      // anything to be proved from there.
      const year = await freeAssessmentYear();
      await apiPost('supervisor', `/taxpayers/${(await demoTaxpayer()).taxpayerId}/account`, {
        entryType: 'ADVANCE_PAYMENT',
        taxTypeCode: 'CIT',
        assessmentYear: year,
        amount: '250.00',
        currencyCode: 'EUR',
        valueDate: today(),
        sourceReference: `E2E-EUR-${year}`,
        narrative: 'Seeded in euro so the account source cannot answer a sterling case.',
      });

      const neverWorked = caseFrom(
        await Workbench.openCase(cast.supervisor, {
          taxpayerId: (await demoTaxpayer()).taxpayerId,
          year,
        }),
      );
      const atTheDoor = new Workbench(cast.supervisor);
      await atTheDoor.retrieveEvidence();
      await atTheDoor.expectStatus('Initiated');

      const rows = await recordALapsedLimitationDeadline([neverWorked.id, beingPrepared.id]);
      expect(rows, 'both cases carry a limitation date that has passed').toBe(2);

      const output = runTheDeadlineSweep({ TIME_BAR_ON_LIMITATION_EXPIRY: 'true' });
      expect(output, 'the sweep ran to completion').toContain('SWEEP_COMPLETED');

      const doorway = await workbenchFor(cast, 'supervisor', neverWorked);
      await doorway.expectStatus('Time barred');
      await doorway.tab('Timeline');

      await recorder.capture(cast.supervisor, {
        id: 'limitation-expired-at-initiation',
        title: 'A limitation period runs out on a case nobody ever worked',
        actor: 'system (deadline sweep)',
        transition: 'INITIATED --LIMITATION_EXPIRED--> TIME_BARRED',
        kind: 'transition',
        description:
          `Case ${neverWorked.caseNumber} never became workable and sat at Initiated until its ` +
          'limitation period ran out. Three things were arranged and are stated plainly: the ' +
          'period was seeded with a euro account entry so the mandatory account source could not ' +
          'answer a sterling case, a LIMITATION deadline row dated two days back was inserted ' +
          'directly because no jurisdiction configures that deadline type and no screen writes ' +
          'one, and the sweep was run in a process of its own with TIME_BAR_ON_LIMITATION_EXPIRY ' +
          'turned on for that process alone, because time-barring is off by default and ' +
          'TIME_BARRED is terminal. The sweep marked the row breached on its ordinary pass and ' +
          'then applied the time bar itself, under a SYSTEM identity, with no status written by ' +
          'this test.',
        expected:
          'The status reads Time barred and the newest history row is DEADLINE_BREACHED, moving the case from Initiated to Time barred with DEADLINE_SWEEP named as what applied it.',
        statusAfter: await doorway.status(),
      });

      const prepared = await workbenchFor(cast, 'supervisor', beingPrepared);
      await prepared.expectStatus('Time barred');
      await prepared.tab('Timeline');

      await recorder.capture(cast.supervisor, {
        id: 'limitation-expired-in-preparation',
        title: 'The same sweep stops an assessment already under way',
        actor: 'system (deadline sweep)',
        transition: 'IN_PREPARATION --LIMITATION_EXPIRED--> TIME_BARRED',
        kind: 'transition',
        description:
          `Case ${beingPrepared.caseNumber} was assigned, started and in preparation when the ` +
          'same sweep reached it, so an assessment an officer was in the middle of is ended by ' +
          'the calendar. Its limitation deadline row was inserted the same way and in the same ' +
          'state as the case above, and both were time-barred by the one sweep. The sweep takes ' +
          'the statuses it may move from out of the transition table rather than restating them, ' +
          'which is why Initiated and In preparation are the two it acts on and why a case under ' +
          'objection or already finalised is never a candidate.',
        expected:
          'The status reads Time barred and the newest history row is DEADLINE_BREACHED, moving the case from In preparation to Time barred.',
        statusAfter: await prepared.status(),
      });
    });
  });
});
