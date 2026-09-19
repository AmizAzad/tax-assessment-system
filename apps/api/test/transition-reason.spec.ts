import { BadRequestException } from '@nestjs/common';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { Sequelize } from 'sequelize';
import { ReferenceNumberService } from '../src/forms/reference-number.service';
import { CaseService } from '../src/tax-assessment/case/case.service';
import type { DeadlineService } from '../src/tax-assessment/deadline/deadline.service';
import type { SlaService } from '../src/tax-assessment/deadline/sla.service';
import type { ProcessOrchestrationService } from '../src/tax-assessment/workflow/process-orchestration.service';
import type { RequestContext } from '../src/platform/auth/request-context';

/**
 * The four lifecycle moves that must be justified, against a real database.
 *
 * Plan reference: V2 section 10.2 rows 3, 11 and 15, plus the write-off.
 *
 * Run with `npm run dev:up`. Database-backed because the thing being proved is
 * that nothing is written when the reason is missing: the status has to be
 * read back off the row, and the ledger entry has to be absent from a table a
 * trigger holds append-only. A mocked Sequelize would prove only that the
 * guard threw.
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
const noopDeadlines = {} as DeadlineService;

const cases = new CaseService(
  sequelize,
  new ReferenceNumberService(sequelize),
  noopSla,
  noopProcesses,
  noopDeadlines,
);

const TIN = `TEST-REASON-${Date.now()}`;

let taxpayerId = 0;
let officerId = 0;

function officer(...roleCodes: RoleCode[]): RequestContext {
  return {
    userId: officerId,
    roleCodes,
    correlationId: `transition-reason-spec-${Date.now()}`,
    jurisdictionCode: 'GB',
    requestedAt: new Date(),
  };
}

function openCase(year: string): Promise<{ id: number }> {
  return cases.create(
    {
      taxpayerId,
      taxTypeCode: 'CIT',
      assessmentYear: year,
      assessmentType: 'DESK',
      triggerPath: 'RISK',
      jurisdictionCode: 'GB',
      currencyCode: 'GBP',
    },
    officer(RoleCode.SUPERVISOR),
  );
}

/**
 * Put a case at the status a branch starts from.
 *
 * Reaching UNDER_REVIEW or PENDING_APPROVAL through `transition` would take
 * five role contexts, an evidence retrieval and a calculation, none of which
 * is the behaviour under test. The move away from that status is what this
 * spec exercises, and that one always goes through `transition`.
 */
async function park(caseId: number, status: CaseStatus): Promise<void> {
  await sequelize.query(
    `UPDATE tax.tax_assessment_case SET status_code = :status WHERE id = :caseId`,
    { replacements: { status, caseId } },
  );
}

function statusOf(caseId: number): Promise<string> {
  return cases.findById(caseId).then((c) => c.statusCode);
}

async function refusal(promise: Promise<unknown>): Promise<BadRequestException> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(BadRequestException);
  return error as BadRequestException;
}

beforeAll(async () => {
  await sequelize.authenticate();
  const [taxpayers] = await sequelize.query(
    `INSERT INTO platform.taxpayer (tin, name, taxpayer_kind, status, jurisdiction_code)
          VALUES ('${TIN}', 'Reason Spec Ltd', 'LEGAL', 'ACTIVE', 'GB')
       RETURNING id`,
  );
  taxpayerId = Number((taxpayers as Array<{ id: string }>)[0]!.id);

  // Rejection records participation and is barred to an unidentified caller,
  // so the acting officer has to be a real row rather than an invented id.
  const [users] = await sequelize.query(
    `SELECT id FROM platform.app_user WHERE is_active ORDER BY id LIMIT 1`,
  );
  officerId = Number((users as Array<{ id: string }>)[0]!.id);
});

/**
 * The cases opened here cannot be deleted: each writes to
 * `tax.tax_assessment_event`, which a trigger holds append-only, and the
 * ledger's foreign key onto the case is RESTRICT. They are deactivated
 * instead, and the fixture taxpayer is unique per run.
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

describe('a cancellation has to say why', () => {
  let caseId = 0;

  beforeAll(async () => {
    caseId = (await openCase('2021')).id;
  });

  it('refuses the cancellation and leaves the case open', async () => {
    const error = await refusal(cases.transition(caseId, 'CANCEL', officer(RoleCode.SUPERVISOR)));
    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Action CANCEL requires a reason');
    expect(await statusOf(caseId)).toBe('INITIATED');
  });

  it('refuses a reason that is only whitespace', async () => {
    const error = await refusal(
      cases.transition(caseId, 'CANCEL', officer(RoleCode.SUPERVISOR), { reason: '   ' }),
    );
    expect(error.getStatus()).toBe(400);
    expect(await statusOf(caseId)).toBe('INITIATED');
  });

  it('cancels the case once the supervisor says why', async () => {
    const moved = await cases.transition(caseId, 'CANCEL', officer(RoleCode.SUPERVISOR), {
      reason: 'Opened against the wrong accounting period; the 2021 return is already assessed.',
    });
    expect(moved.statusCode).toBe('CANCELLED');
  });

  it('writes the reason onto the ledger entry for the cancellation', async () => {
    const entry = (await cases.timeline(caseId)).find((e) => e.toStatus === 'CANCELLED');
    expect(entry?.payload?.['reason']).toBe(
      'Opened against the wrong accounting period; the 2021 return is already assessed.',
    );
  });
});

describe('a return for rework has to say why', () => {
  let caseId = 0;

  beforeAll(async () => {
    caseId = (await openCase('2022')).id;
    await park(caseId, CaseStatus.UNDER_REVIEW);
  });

  it('refuses the return and leaves the case under review', async () => {
    const error = await refusal(cases.transition(caseId, 'RETURN', officer(RoleCode.REVIEWER)));
    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Action RETURN requires a reason');
    expect(await statusOf(caseId)).toBe('UNDER_REVIEW');
  });

  it('returns the case once the reviewer says what is wrong with it', async () => {
    const moved = await cases.transition(caseId, 'RETURN', officer(RoleCode.REVIEWER), {
      reason:
        'The disallowed entertaining is not evidenced; attach the invoices before resubmitting.',
    });
    expect(moved.statusCode).toBe('REVIEW_RETURNED');
  });
});

describe('a rejection has to say why', () => {
  let caseId = 0;

  beforeAll(async () => {
    caseId = (await openCase('2023')).id;
    await park(caseId, CaseStatus.PENDING_APPROVAL);
  });

  it('refuses the rejection and leaves the case pending approval', async () => {
    const error = await refusal(cases.transition(caseId, 'REJECT', officer(RoleCode.APPROVER_L1)));
    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Action REJECT requires a reason');
    expect(await statusOf(caseId)).toBe('PENDING_APPROVAL');
  });

  it('rejects the case once the approver says why they will not sign it', async () => {
    const moved = await cases.transition(caseId, 'REJECT', officer(RoleCode.APPROVER_L1), {
      reason: 'The transfer pricing adjustment cites no comparables. Rework before resubmission.',
    });
    expect(moved.statusCode).toBe('REJECTED');
  });
});

describe('a write-off has to say why', () => {
  let caseId = 0;

  beforeAll(async () => {
    caseId = (await openCase('2024')).id;
    await park(caseId, CaseStatus.AWAITING_TAXPAYER_RESPONSE);
  });

  it('refuses the write-off and leaves the debt standing', async () => {
    const error = await refusal(
      cases.transition(caseId, 'WRITE_OFF', officer(RoleCode.SUPERVISOR)),
    );
    expect(error.getStatus()).toBe(400);
    expect(error.message).toContain('Action WRITE_OFF requires a reason');
    expect(await statusOf(caseId)).toBe('AWAITING_TAXPAYER_RESPONSE');
  });

  it('writes the debt off once the supervisor says on what judgement', async () => {
    const moved = await cases.transition(caseId, 'WRITE_OFF', officer(RoleCode.SUPERVISOR), {
      reason: 'Company dissolved; no assets and no successor to pursue.',
    });
    expect(moved.statusCode).toBe('WRITTEN_OFF');
  });
});

describe('an unflagged action is unaffected', () => {
  it('accepts a review with no reason at all', async () => {
    const opened = await openCase('2025');
    await park(opened.id, CaseStatus.UNDER_REVIEW);
    const moved = await cases.transition(opened.id, 'ACCEPT', officer(RoleCode.REVIEWER));
    expect(moved.statusCode).toBe('REVIEWED');
  });
});
