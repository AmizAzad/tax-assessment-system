import { Inject, Injectable, Logger } from '@nestjs/common';
import { RoleCode, statusesWithAction } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { CaseService } from '../case/case.service';

export interface SettlementOutcome {
  readonly caseId: number;
  readonly caseNumber: string;
  readonly assessed: string;
  readonly paid: string;
  readonly outstanding: string;
  readonly settled: boolean;
}

/**
 * Noticing when a taxpayer has actually paid.
 *
 * Plan reference: V2 sections 14.4, 9.4 (Phase 7).
 *
 * ## Why this exists
 *
 * `PAYMENT_SETTLED` is a SYSTEM transition in the case machine, and until now
 * nothing performed it. A case therefore sat at AWAITING_TAXPAYER_RESPONSE
 * after the money arrived, and the auto-closure sweep, which only looks at
 * settled cases, could never see it. The lifecycle had an end state nothing
 * could reach.
 *
 * ## Why settlement is evaluated rather than asserted
 *
 * Nobody presses "settled". The platform compares what was assessed with what
 * has been received and draws the conclusion. A button would let a case be
 * marked paid without the money, which is the single most damaging false
 * record a revenue system can hold.
 *
 * ## Tolerance
 *
 * A residue smaller than the configured tolerance settles the case. Chasing a
 * taxpayer for two pence costs more than the two pence, and every authority
 * has a de minimis. It is deliberately small and explicit rather than a
 * rounding accident.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  /**
   * The de minimis residue.
   *
   * Hard-coded at one unit of currency for now, and flagged as configuration
   * that belongs in master data once a second jurisdiction needs a different
   * figure. Stated here so it is visible rather than buried in a comparison.
   */
  private static readonly TOLERANCE = '1.00';

  /**
   * The statuses PAYMENT_SETTLED is legal from, read off the transition table.
   *
   * An upheld appeal is as payable as a served notice, and the table says so.
   * Naming AWAITING_TAXPAYER_RESPONSE here instead meant a taxpayer who lost an
   * appeal and then paid stayed in APPEAL_UPHELD with no way out.
   */
  private static readonly SETTLEABLE = statusesWithAction('PAYMENT_SETTLED');

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
  ) {}

  /**
   * Re-evaluate every open case for a taxpayer period.
   *
   * Called after a payment is recorded. Scoped to the period rather than the
   * case because a payment is made against a liability, not against a case
   * number, and two cases can exist for one period over its life.
   */
  async evaluatePeriod(
    taxpayerId: number,
    taxTypeCode: string,
    assessmentYear: string,
    caller: RequestContext,
  ): Promise<readonly SettlementOutcome[]> {
    const rows = await this.sequelize.query<{ id: string }>(
      `SELECT id::text AS id
         FROM tax.tax_assessment_case
        WHERE taxpayer_id = :taxpayerId
          AND tax_type_code = :taxTypeCode
          AND assessment_year = :assessmentYear
          AND status_code IN (:settleable)
          AND is_active`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          taxpayerId,
          taxTypeCode,
          assessmentYear,
          settleable: [...SettlementService.SETTLEABLE],
        },
      },
    );

    const outcomes: SettlementOutcome[] = [];
    for (const row of rows) {
      outcomes.push(await this.evaluate(Number(row.id), caller));
    }
    return outcomes;
  }

  /**
   * Has this case been paid?
   *
   * Returns the position either way, so the caller can show "1,200 still
   * outstanding" rather than only a boolean.
   */
  async evaluate(caseId: number, caller: RequestContext): Promise<SettlementOutcome> {
    const assessmentCase = await this.cases.findById(caseId);
    const currency = assessmentCase.currencyCode;

    const result = await this.sequelize.query<{ net: string | null }>(
      `SELECT net_payable_or_refundable::text AS net
         FROM tax.tax_calculation_result
        WHERE case_id = :caseId AND is_current`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    // The calculation's net figure is already net of the payments known when
    // it ran. Payments received since then are the ones that close the gap.
    const assessedNet = Money.of(result[0]?.net ?? '0', currency);

    const since = await this.sequelize.query<{ total: string | null }>(
      `SELECT COALESCE(sum(e.amount), 0)::text AS total
         FROM tax.taxpayer_account_entry e
         JOIN tax.tax_calculation_result r ON r.case_id = :caseId AND r.is_current
        WHERE e.taxpayer_id = :taxpayerId
          AND e.tax_type_code = :taxTypeCode
          AND e.assessment_year = :assessmentYear
          AND e.entry_type IN ('PAYMENT', 'ADVANCE_PAYMENT')
          AND e.is_active
          AND e.created_at > r.calculated_at`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          caseId,
          taxpayerId: assessmentCase.taxpayerId,
          taxTypeCode: assessmentCase.taxTypeCode,
          assessmentYear: assessmentCase.assessmentYear,
        },
      },
    );

    const paidSince = Money.of(since[0]?.total ?? '0', currency);
    const outstanding = assessedNet.subtract(paidSince);
    const tolerance = Money.of(SettlementService.TOLERANCE, currency);
    const settled = outstanding.lessThanOrEqual(tolerance);

    const outcome: SettlementOutcome = {
      caseId,
      caseNumber: assessmentCase.caseNumber,
      assessed: assessedNet.toFixed(2),
      paid: paidSince.toFixed(2),
      outstanding: outstanding.toFixed(2),
      settled,
    };

    if (!settled) return outcome;
    if (!SettlementService.SETTLEABLE.includes(assessmentCase.statusCode)) return outcome;

    // SYSTEM, because the platform is reporting that money arrived, not
    // recording anybody's opinion that it did.
    await this.cases.transition(
      caseId,
      'PAYMENT_SETTLED',
      { ...caller, roleCodes: [RoleCode.SYSTEM] },
      { assessed: outcome.assessed, paid: outcome.paid, outstanding: outcome.outstanding },
    );

    this.logger.log(
      `Case ${assessmentCase.caseNumber} settled: assessed ${outcome.assessed}, ` +
        `received ${outcome.paid} since the calculation`,
    );
    return outcome;
  }
}
