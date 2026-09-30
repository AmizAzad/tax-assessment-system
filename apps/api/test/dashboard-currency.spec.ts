import { RoleCode } from '@tas/contracts';
import { QueryTypes, Sequelize } from 'sequelize';
import { DashboardService } from '../src/tax-assessment/dashboard/dashboard.service';
import type { RequestContext } from '../src/platform/auth/request-context';

/**
 * The dashboard's money tiles, against a real database.
 *
 * Plan reference: V2 section 21.3; ADR-007.
 *
 * Run with `npm run dev:up`. Database-backed because the defect was in the
 * SQL: one `sum()` over every visible case added sterling to riyal and the
 * tile printed the total as "GBP, SAR". The caller here is an assessor
 * assigned only to the two fixture cases, so the figures are exactly theirs.
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

const RUN = Date.now();
const TIN = `TEST-DASH-${RUN}`;

let userId = 0;
let taxpayerId = 0;
const caseIds: number[] = [];

async function one<T extends object>(
  sql: string,
  replacements: Record<string, unknown>,
): Promise<T> {
  const rows = await sequelize.query<T>(sql, { type: QueryTypes.SELECT, replacements });
  return rows[0]!;
}

async function openCase(year: string, currency: string, net: string): Promise<void> {
  const row = await one<{ id: string }>(
    `INSERT INTO tax.tax_assessment_case
            (case_number, taxpayer_id, tin, taxpayer_name, tax_type_code, jurisdiction_code,
             assessment_year, assessment_type, trigger_path, status_code, currency_code)
     VALUES (:number, :taxpayerId, :tin, 'Dashboard Spec Ltd', 'CIT', 'GB',
             :year, 'DESK', 'RISK', 'CALCULATED', :currency)
     RETURNING id`,
    { number: `TD${RUN}${year}`, taxpayerId, tin: TIN, year, currency },
  );
  const caseId = Number(row.id);
  caseIds.push(caseId);

  await sequelize.query(
    `INSERT INTO tax.tax_assessment_assignment (case_id, user_id, role_code)
     VALUES (:caseId, :userId, 'TA_ASSESSOR')`,
    { replacements: { caseId, userId } },
  );
  await sequelize.query(
    `INSERT INTO tax.tax_calculation_result
            (case_id, version, rule_set_id, rule_set_version, inputs_hash, currency_code,
             net_payable_or_refundable, is_current)
     SELECT :caseId, 1, id, version, 'dashboard-spec', :currency, :net, true
       FROM tax.tax_rule_set ORDER BY id LIMIT 1`,
    { replacements: { caseId, currency, net } },
  );
}

function assessor(): RequestContext {
  return {
    userId,
    roleCodes: [RoleCode.ASSESSOR],
    correlationId: `dashboard-spec-${RUN}`,
    jurisdictionCode: 'GB',
    requestedAt: new Date(),
  };
}

beforeAll(async () => {
  await sequelize.authenticate();
  userId = Number(
    (
      await one<{ id: string }>(
        `INSERT INTO platform.app_user (external_subject, username, display_name)
         VALUES (:subject, :subject, :subject) RETURNING id`,
        { subject: `dashboard-spec-${RUN}` },
      )
    ).id,
  );
  taxpayerId = Number(
    (
      await one<{ id: string }>(
        `INSERT INTO platform.taxpayer (tin, name, taxpayer_kind, status, jurisdiction_code)
         VALUES (:tin, 'Dashboard Spec Ltd', 'LEGAL', 'ACTIVE', 'GB') RETURNING id`,
        { tin: TIN },
      )
    ).id,
  );
  await openCase('2201', 'GBP', '1000.50');
  await openCase('2202', 'SAR', '2000.25');
});

// Nothing here writes to the append-only ledger, so every fixture row can go.
afterAll(async () => {
  if (caseIds.length > 0) {
    const replacements = { caseIds };
    await sequelize.query(`DELETE FROM tax.tax_calculation_result WHERE case_id IN (:caseIds)`, {
      replacements,
    });
    await sequelize.query(`DELETE FROM tax.tax_assessment_assignment WHERE case_id IN (:caseIds)`, {
      replacements,
    });
    await sequelize.query(`DELETE FROM tax.tax_assessment_case WHERE id IN (:caseIds)`, {
      replacements,
    });
  }
  await sequelize.query(`DELETE FROM platform.taxpayer WHERE id = :taxpayerId`, {
    replacements: { taxpayerId },
  });
  await sequelize.query(`DELETE FROM platform.app_user WHERE id = :userId`, {
    replacements: { userId },
  });
  await sequelize.close();
});

describe('DashboardService.summary', () => {
  it('totals the net assessed per currency, never across them', async () => {
    const summary = await new DashboardService(sequelize).summary(assessor());

    expect(summary['net_assessed_by_currency']).toEqual([
      { currency: 'GBP', amount: '1000.5000' },
      { currency: 'SAR', amount: '2000.2500' },
    ]);
  });

  it('leaves the flat total empty when the cases are in more than one currency', async () => {
    const summary = await new DashboardService(sequelize).summary(assessor());

    expect(summary['net_assessed']).toBeNull();
    expect(summary['currencies']).toBe('GBP, SAR');
  });

  it('reports nothing collected as an empty list rather than a zero in no currency', async () => {
    const summary = await new DashboardService(sequelize).summary(assessor());

    expect(summary['collected_by_currency']).toEqual([]);
  });
});
