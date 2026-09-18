import { ConflictException } from '@nestjs/common';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { Sequelize } from 'sequelize';
import { ReferenceNumberService } from '../src/forms/reference-number.service';
import { CaseService } from '../src/tax-assessment/case/case.service';
import type { SlaService } from '../src/tax-assessment/deadline/sla.service';
import type { ProcessOrchestrationService } from '../src/tax-assessment/workflow/process-orchestration.service';
import type { RequestContext } from '../src/platform/auth/request-context';

/**
 * Case version, against a real database.
 *
 * Plan reference: V2 sections 8.2, 10.2, 16.2.
 *
 * Run with `npm run dev:up`. The unique index `ux_case_scope_version` covers
 * (taxpayer, tax type, year, version) for every status but CANCELLED, so the
 * version is the only thing that lets a successor exist alongside a closed
 * predecessor. A case opened without one lands on the database default of 1
 * and collides, which turns a lawful reassessment into a 500. That collision
 * is only observable against the real index, so this spec is database-backed.
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

const noopSla = {} as SlaService;
const noopProcesses = {
  onCaseOpened: async () => undefined,
} as unknown as ProcessOrchestrationService;

const cases = new CaseService(
  sequelize,
  new ReferenceNumberService(sequelize),
  noopSla,
  noopProcesses,
);

const supervisor: RequestContext = {
  roleCodes: [RoleCode.SUPERVISOR],
  correlationId: `case-version-spec-${Date.now()}`,
  jurisdictionCode: 'GB',
  requestedAt: new Date(),
};

const TIN = `TEST-VERSION-${Date.now()}`;
const YEAR = '2026';

let taxpayerId = 0;

function openCase(): Promise<{ id: number; caseNumber: string; version: number }> {
  return cases.create(
    {
      taxpayerId,
      taxTypeCode: 'CIT',
      assessmentYear: YEAR,
      assessmentType: 'DESK',
      triggerPath: 'RISK',
      jurisdictionCode: 'GB',
      currencyCode: 'GBP',
    },
    supervisor,
  );
}

/**
 * Arrange a closed predecessor without driving the fourteen-step lifecycle.
 *
 * Closure is the precondition here, not the behaviour under test, and running
 * it through `transition` would need five different role contexts and turn
 * this into a lifecycle test.
 */
async function close(caseId: number): Promise<void> {
  await sequelize.query(
    `UPDATE tax.tax_assessment_case
        SET status_code = '${CaseStatus.CLOSED}', closed_at = CURRENT_TIMESTAMP
      WHERE id = ${caseId}`,
  );
}

function scopeVersions(): Promise<Array<{ version: number; status_code: string }>> {
  return sequelize
    .query(
      `SELECT version, status_code FROM tax.tax_assessment_case
        WHERE taxpayer_id = ${taxpayerId} AND tax_type_code = 'CIT'
          AND assessment_year = '${YEAR}'
        ORDER BY id`,
    )
    .then(([rows]) => rows as Array<{ version: number; status_code: string }>);
}

beforeAll(async () => {
  await sequelize.authenticate();
  const [rows] = await sequelize.query(
    `INSERT INTO platform.taxpayer (tin, name, taxpayer_kind, status, jurisdiction_code)
          VALUES ('${TIN}', 'Version Spec Ltd', 'LEGAL', 'ACTIVE', 'GB')
       RETURNING id`,
  );
  taxpayerId = Number((rows as Array<{ id: string }>)[0]!.id);
});

/**
 * The cases this spec opens cannot be deleted. Each one writes a row to
 * `tax.tax_assessment_event`, which a database trigger holds append-only, and
 * the ledger's foreign key onto the case is RESTRICT. They are deactivated
 * instead, which drops them out of every register read, and the fixture
 * taxpayer is unique per run so the residue never meets another run.
 */
afterAll(async () => {
  if (taxpayerId > 0) {
    await sequelize.query(
      `UPDATE tax.tax_assessment_case SET is_active = false WHERE taxpayer_id = ${taxpayerId}`,
    );
    await sequelize.query(
      `UPDATE platform.taxpayer SET is_active = false WHERE id = ${taxpayerId}`,
    );
  }
  await sequelize.close();
});

describe('case version', () => {
  let first = 0;
  let second = 0;

  it('opens the first case in a scope at version 1', async () => {
    const opened = await openCase();
    first = opened.id;
    expect(opened.version).toBe(1);
  });

  it('opens the next case at version 2 once the predecessor is closed', async () => {
    await close(first);
    const opened = await openCase();
    second = opened.id;
    expect(opened.version).toBe(2);
  });

  it('opens a third case at version 3 once the second is closed', async () => {
    await close(second);
    const opened = await openCase();
    expect(opened.version).toBe(3);
  });

  it('still refuses a second case while one in the scope is live', async () => {
    const refusal = await openCase().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect((refusal as ConflictException).getStatus()).toBe(409);
  });

  it('leaves each predecessor at its own version, so the rows coexist', async () => {
    expect(await scopeVersions()).toEqual([
      { version: 1, status_code: 'CLOSED' },
      { version: 2, status_code: 'CLOSED' },
      { version: 3, status_code: 'INITIATED' },
    ]);
  });
});
