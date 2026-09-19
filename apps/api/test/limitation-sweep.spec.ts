import { Sequelize } from 'sequelize';
import type { AppConfig } from '../src/config/configuration';
import { ReferenceNumberService } from '../src/forms/reference-number.service';
import { JobRegistryService } from '../src/platform/scheduling/job-registry.service';
import type { NotificationService } from '../src/platform/notification/notification.service';
import type { RequestContext } from '../src/platform/auth/request-context';
import { CaseService } from '../src/tax-assessment/case/case.service';
import { DeadlineScheduler } from '../src/tax-assessment/deadline/deadline.scheduler';
import { DeadlineService } from '../src/tax-assessment/deadline/deadline.service';
import type { SlaService } from '../src/tax-assessment/deadline/sla.service';
import type { ProcessOrchestrationService } from '../src/tax-assessment/workflow/process-orchestration.service';
import { RoleCode } from '@tas/contracts';

/**
 * `@nestjs/schedule` ships ESM only, and this suite runs under the CJS ts-jest
 * preset, so requiring it is a parse error before a single test runs. Nothing
 * here goes through cron anyway; `sweep()` is called directly.
 */
jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
  CronExpression: { EVERY_HOUR: '0 * * * *' },
}));

/**
 * The platform time-barring a case on its own (ADR-017).
 *
 * Run with `npm run dev:up`. Database-backed because the behaviour under test
 * is a SELECT over two tables joined on four bounds, and the one thing that
 * matters about it is which cases it does *not* return. A mocked query would
 * be the test author restating the bounds they just wrote.
 */

const sequelize = new Sequelize({
  dialect: 'postgres',
  host: process.env['DB_HOST'] ?? 'localhost',
  port: Number(process.env['DB_PORT'] ?? 5433),
  username: process.env['DB_USER'] ?? 'tas',
  password: process.env['DB_PASSWORD'] ?? 'tas_local_dev_only',
  database: process.env['DB_NAME'] ?? 'tax_assessment',
  logging: false,
});

const noopSla = { applyTransition: async () => undefined } as unknown as SlaService;
const noopProcesses = {
  onCaseOpened: async () => undefined,
  onTransition: async () => undefined,
  onCaseClosed: async () => undefined,
} as unknown as ProcessOrchestrationService;
const noopNotifications = { send: async () => undefined } as unknown as NotificationService;

const cases = new CaseService(
  sequelize,
  new ReferenceNumberService(sequelize),
  noopSla,
  noopProcesses,
  new DeadlineService(sequelize),
);

/**
 * Only the two flags the services under test read.
 *
 * Building the real configuration would make this spec depend on the
 * environment holding a database password, which is the one thing it already
 * has from its own defaults.
 */
function configWith(timeBarOnLimitationExpiry: boolean): AppConfig {
  return { schedulerEnabled: true, timeBarOnLimitationExpiry } as AppConfig;
}

function schedulerWith(timeBarOnLimitationExpiry: boolean): DeadlineScheduler {
  const config = configWith(timeBarOnLimitationExpiry);
  return new DeadlineScheduler(
    sequelize,
    cases,
    noopNotifications,
    new JobRegistryService(sequelize, config),
    config,
  );
}

const sweepOn = schedulerWith(true);
const sweepOff = schedulerWith(false);

const supervisor: RequestContext = {
  roleCodes: [RoleCode.SUPERVISOR],
  correlationId: `limitation-sweep-spec-${Date.now()}`,
  jurisdictionCode: 'GB',
  requestedAt: new Date(),
};

const TIN = `TEST-LIMITATION-${Date.now()}`;

let taxpayerId = 0;

async function openCase(assessmentYear: string): Promise<number> {
  const opened = await cases.create(
    {
      taxpayerId,
      taxTypeCode: 'CIT',
      assessmentYear,
      assessmentType: 'DESK',
      triggerPath: 'RISK',
      jurisdictionCode: 'GB',
      currencyCode: 'GBP',
    },
    supervisor,
  );
  return opened.id;
}

/**
 * Put the case in the status the sweep will meet it in.
 *
 * Driving the lifecycle through `transition` would need four role contexts and
 * an assignee, and the route taken to a status is not what decides whether the
 * sweep may act on it.
 */
async function setStatus(caseId: number, statusCode: string): Promise<void> {
  await sequelize.query(
    `UPDATE tax.tax_assessment_case SET status_code = '${statusCode}' WHERE id = ${caseId}`,
  );
}

async function holdCase(caseId: number): Promise<void> {
  await sequelize.query(
    `UPDATE tax.tax_assessment_case SET legal_hold = true WHERE id = ${caseId}`,
  );
}

/**
 * Insert the limitation deadline rather than materialise one.
 *
 * No jurisdiction shipped today configures a LIMITATION row in
 * `tax.tax_deadline_config`, so there is nothing for the deadline service to
 * materialise from. The row goes in OPEN, which means the sweep's own
 * `markBreached` has to run before `applyLimitationExpiry` can see it, and a
 * reordering of the two passes fails this spec.
 */
async function giveLapsedLimitation(caseId: number): Promise<void> {
  await sequelize.query(
    `INSERT INTO tax.tax_assessment_deadline
            (case_id, deadline_type, anchor_event, anchor_at, due_at, status)
     VALUES (${caseId}, 'LIMITATION', 'CASE_OPENED',
             CURRENT_TIMESTAMP - INTERVAL '400 days',
             CURRENT_TIMESTAMP - INTERVAL '30 days', 'OPEN')`,
  );
}

async function statusOf(caseId: number): Promise<string> {
  const [rows] = await sequelize.query(
    `SELECT status_code FROM tax.tax_assessment_case WHERE id = ${caseId}`,
  );
  return (rows as Array<{ status_code: string }>)[0]!.status_code;
}

async function timeBarEvents(caseId: number): Promise<number> {
  const [rows] = await sequelize.query(
    `SELECT count(*)::int AS n FROM tax.tax_assessment_event
      WHERE case_id = ${caseId} AND event_type = 'DEADLINE_BREACHED'
        AND to_status = 'TIME_BARRED'`,
  );
  return (rows as Array<{ n: number }>)[0]!.n;
}

async function lastJobStatus(): Promise<string | null> {
  const [rows] = await sequelize.query(
    `SELECT last_status FROM platform.scheduled_job WHERE job_code = 'DEADLINE_SWEEP'`,
  );
  return (rows as Array<{ last_status: string | null }>)[0]?.last_status ?? null;
}

beforeAll(async () => {
  await sequelize.authenticate();
  const [rows] = await sequelize.query(
    `INSERT INTO platform.taxpayer (tin, name, taxpayer_kind, status, jurisdiction_code)
          VALUES ('${TIN}', 'Limitation Spec Ltd', 'LEGAL', 'ACTIVE', 'GB')
       RETURNING id`,
  );
  taxpayerId = Number((rows as Array<{ id: string }>)[0]!.id);

  await sweepOn.onModuleInit();
  // A replica that died mid-sweep leaves the row claimed, and `runExclusively`
  // would then stand down and every assertion below would pass against a sweep
  // that never ran.
  await sequelize.query(
    `UPDATE platform.scheduled_job SET last_status = 'SUCCESS', enabled = true
      WHERE job_code = 'DEADLINE_SWEEP'`,
  );
});

/**
 * The cases this spec opens cannot be deleted. Each one writes to
 * `tax.tax_assessment_event`, which a database trigger holds append-only, and
 * the ledger's foreign key onto the case is RESTRICT. They are deactivated
 * instead, along with their deadlines, so a later sweep cannot pick them up,
 * and the fixture taxpayer is unique per run.
 */
afterAll(async () => {
  if (taxpayerId > 0) {
    await sequelize.query(
      `UPDATE tax.tax_assessment_deadline SET is_active = false
        WHERE case_id IN (SELECT id FROM tax.tax_assessment_case WHERE taxpayer_id = ${taxpayerId})`,
    );
    await sequelize.query(
      `UPDATE tax.tax_assessment_case SET is_active = false WHERE taxpayer_id = ${taxpayerId}`,
    );
    await sequelize.query(
      `UPDATE platform.taxpayer SET is_active = false WHERE id = ${taxpayerId}`,
    );
  }
  await sequelize.close();
});

describe('limitation sweep', () => {
  let barredFromPreparation = 0;

  it('time-bars a case in IN_PREPARATION when the flag is on', async () => {
    barredFromPreparation = await openCase('2001');
    await setStatus(barredFromPreparation, 'IN_PREPARATION');
    await giveLapsedLimitation(barredFromPreparation);

    await sweepOn.sweep();

    expect(await statusOf(barredFromPreparation)).toBe('TIME_BARRED');
    expect(await lastJobStatus()).toBe('SUCCESS');
  });

  it('time-bars a case in INITIATED when the flag is on', async () => {
    const caseId = await openCase('2002');
    await giveLapsedLimitation(caseId);
    expect(await statusOf(caseId)).toBe('INITIATED');

    await sweepOn.sweep();

    expect(await statusOf(caseId)).toBe('TIME_BARRED');
  });

  it('leaves the case alone when the flag is off', async () => {
    const caseId = await openCase('2003');
    await setStatus(caseId, 'IN_PREPARATION');
    await giveLapsedLimitation(caseId);

    await sweepOff.sweep();

    expect(await statusOf(caseId)).toBe('IN_PREPARATION');
    expect(await timeBarEvents(caseId)).toBe(0);
  });

  it('never touches a case under legal hold', async () => {
    const caseId = await openCase('2004');
    await setStatus(caseId, 'IN_PREPARATION');
    await holdCase(caseId);
    await giveLapsedLimitation(caseId);

    await sweepOn.sweep();

    expect(await statusOf(caseId)).toBe('IN_PREPARATION');
    expect(await timeBarEvents(caseId)).toBe(0);
  });

  it('never touches a status the transition table does not declare', async () => {
    const caseId = await openCase('2005');
    await setStatus(caseId, 'ASSIGNED');
    await giveLapsedLimitation(caseId);

    await sweepOn.sweep();

    expect(await statusOf(caseId)).toBe('ASSIGNED');
    expect(await timeBarEvents(caseId)).toBe(0);
  });

  it('converges on a second pass rather than writing a second event', async () => {
    const caseId = await openCase('2006');
    await setStatus(caseId, 'IN_PREPARATION');
    await giveLapsedLimitation(caseId);

    await sweepOn.sweep();
    const afterFirst = await timeBarEvents(caseId);

    await sweepOn.sweep();

    expect(afterFirst).toBe(1);
    expect(await timeBarEvents(caseId)).toBe(1);
    expect(await statusOf(caseId)).toBe('TIME_BARRED');
    expect(await lastJobStatus()).toBe('SUCCESS');
  });

  it('records the platform, not an officer, as what applied it', async () => {
    const [rows] = await sequelize.query(
      `SELECT payload_json ->> 'appliedBy' AS applied_by,
              payload_json ->> 'appliedByJob' AS applied_by_job,
              actor_user_id
         FROM tax.tax_assessment_event
        WHERE case_id = ${barredFromPreparation}
          AND event_type = 'DEADLINE_BREACHED'
          AND to_status = 'TIME_BARRED'`,
    );
    expect(rows as unknown[]).toEqual([
      { applied_by: 'PLATFORM', applied_by_job: 'DEADLINE_SWEEP', actor_user_id: null },
    ]);
  });
});
