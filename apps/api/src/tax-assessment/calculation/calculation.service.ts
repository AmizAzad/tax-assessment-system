import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { CaseEventType, CaseStatus, areFiguresLocked, isFrozenStatus } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { currentUserId } from '../../platform/auth/request-context';
import { AdjustmentService } from '../case/adjustment.service';
import { CaseService } from '../case/case.service';
import { calculate, hashInputs } from './pipeline';
import { RuleSetService } from './rule-set.service';
import { DeadlineService } from '../deadline/deadline.service';
import { EvidenceService } from '../evidence/evidence.service';
import type { CalculationInputs, CalculationResult } from './types';

export interface StoredCalculation {
  readonly id: number;
  readonly version: number;
  readonly ruleSetCode: string;
  readonly ruleSetVersion: number;
  readonly inputsHash: string;
  /**
   * The figures behind the taxable base.
   *
   * Stored since the first migration but previously not read back, which left
   * the API unable to answer the first question a reviewer asks: what did the
   * taxpayer declare, and what did we change.
   */
  readonly declaredBase: string;
  readonly totalAdjustments: string;
  readonly assessedBase: string;
  readonly lossesSetOff: string;
  readonly taxableBase: string;
  readonly taxBeforeCredits: string;
  readonly totalCredits: string;
  readonly taxAfterCredits: string;
  readonly penaltyAmount: string;
  readonly interestAmount: string;
  readonly totalPayable: string;
  readonly netPayableOrRefundable: string;
  readonly currencyCode: string;
  readonly calculatedAt: Date;
  readonly trace: ReadonlyArray<{
    sequence: number;
    step: string;
    descriptionKey: string;
    expression: string;
    output: string;
    ruleReference: string | null;
  }>;
}

/**
 * Runs the calculation and persists the result.
 *
 * Plan reference: V2 sections 8.2 stage 5, 14.4; ADR-006, ADR-007.
 *
 * The bridge between the pure pipeline and the domain. It gathers inputs,
 * resolves the rule set in force for the period, runs the pipeline and stores
 * the result with its trace.
 *
 * ## Results are immutable and versioned
 *
 * Recalculation inserts a new version and flips `is_current` in one
 * transaction. The figure a notice was served on can always be recovered,
 * which is the whole point: an assessment under appeal is defended on the
 * numbers as they stood, not as they would be recomputed today.
 *
 * ## A frozen case cannot be recalculated
 *
 * Once finalised, the figures are the legal determination. Changing them
 * requires a reassessment, which creates a successor case.
 */
@Injectable()
export class CalculationService {
  private readonly logger = new Logger(CalculationService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    private readonly adjustments: AdjustmentService,
    private readonly ruleSets: RuleSetService,
    private readonly evidence: EvidenceService,
    private readonly deadlines: DeadlineService,
  ) {}

  /**
   * Calculate and persist.
   *
   * Idempotent in effect: re-running with unchanged inputs produces the same
   * figures and the same hash. It still writes a new version, because "the
   * officer asked for a recalculation at this time" is itself a fact worth
   * recording.
   */
  async calculateForCase(caseId: number, caller: RequestContext): Promise<StoredCalculation> {
    const assessmentCase = await this.cases.findById(caseId);

    if (isFrozenStatus(assessmentCase.statusCode)) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}. Its figures are the ` +
          `legal determination and cannot be recomputed — raise a reassessment instead.`,
      );
    }
    if (areFiguresLocked(assessmentCase.statusCode)) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}: its figures are ` +
          `being reviewed or approved and cannot be recomputed. Return it for rework first.`,
      );
    }

    const inputs = await this.gatherInputs(caseId, assessmentCase);

    // The period being assessed decides which rules apply, not today's date.
    const effectiveOn = `${assessmentCase.assessmentYear}-12-31`;
    const ruleSet = await this.ruleSets.resolve(
      assessmentCase.jurisdictionCode,
      assessmentCase.taxTypeCode,
      effectiveOn,
    );

    const result = calculate(inputs, ruleSet);
    const inputsHash = hashInputs(inputs, ruleSet);

    const stored = await this.persist(
      caseId,
      assessmentCase.statusCode,
      result,
      ruleSet.id,
      inputsHash,
      caller,
    );

    // A case in preparation moves to CALCULATED once there is a figure. The
    // transition is the assessor's own, not SYSTEM: producing a figure is an
    // act of the officer preparing the case, and the state machine records it
    // as such. Recalculating an already-calculated case leaves the status
    // alone, because there is no transition from CALCULATED on this action and
    // attempting one would fail a legitimate recalculation.
    if (assessmentCase.statusCode === CaseStatus.IN_PREPARATION) {
      await this.cases.transition(caseId, 'CALCULATE', caller, {
        calculationVersion: stored.version,
        netPayable: stored.netPayableOrRefundable,
      });
    }

    return stored;
  }

  /**
   * Calculate without persisting.
   *
   * For the what-if panel. Deliberately separate from the persisting path so
   * an exploratory calculation can never become the case's current figure.
   */
  async preview(caseId: number): Promise<CalculationResult> {
    const assessmentCase = await this.cases.findById(caseId);
    const inputs = await this.gatherInputs(caseId, assessmentCase);
    const ruleSet = await this.ruleSets.resolve(
      assessmentCase.jurisdictionCode,
      assessmentCase.taxTypeCode,
      `${assessmentCase.assessmentYear}-12-31`,
    );
    return calculate(inputs, ruleSet);
  }

  async currentFor(caseId: number): Promise<StoredCalculation | null> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT r.*, s.code AS rule_set_code
         FROM tax.tax_calculation_result r
         JOIN tax.tax_rule_set s ON s.id = r.rule_set_id
        WHERE r.case_id = :caseId AND r.is_current`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    const row = rows[0];
    if (row === undefined) return null;
    return { ...toStored(row), trace: await this.traceFor(Number(row['id'])) };
  }

  /** Every version, newest first. How a figure change is explained. */
  async historyFor(caseId: number): Promise<readonly StoredCalculation[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT r.*, s.code AS rule_set_code
         FROM tax.tax_calculation_result r
         JOIN tax.tax_rule_set s ON s.id = r.rule_set_id
        WHERE r.case_id = :caseId
        ORDER BY r.version DESC`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    return Promise.all(
      rows.map(async (row) => ({
        ...toStored(row),
        trace: await this.traceFor(Number(row['id'])),
      })),
    );
  }

  // ---------------------------------------------------------------- internals

  private async gatherInputs(
    caseId: number,
    assessmentCase: {
      id: number;
      currencyCode: string;
      assessmentYear: string;
      jurisdictionCode: string;
      taxTypeCode: string;
    },
  ): Promise<CalculationInputs> {
    const currency = assessmentCase.currencyCode;

    // The declared base is the sum of filed item amounts. Where no items have
    // been captured yet it is zero, and the calculation is of an entirely
    // adjusted base — which is what a non-filer assessment looks like.
    const declared = await this.sequelize.query<{ total: string | null }>(
      `SELECT COALESCE(sum(declared_amount), 0)::text AS total
         FROM tax.tax_assessment_item
        WHERE case_id = :caseId AND is_active`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    const totalAdjustments = await this.adjustments.netTotal(caseId, currency);

    // Read back from the frozen snapshot, never re-fetched from the source
    // systems. Two calculations of the same case must see the same facts even
    // if a bank feed moved in between, or the reviewer's figure would not
    // reproduce the assessor's (plan 8.3).
    const fromEvidence = await this.evidence.calculationInputsFor(caseId, currency);

    const { filingDaysLate, daysLate } = await this.deadlines.lateness(
      assessmentCase,
      fromEvidence.filedOn,
      fromEvidence.dueOn,
    );

    return {
      currencyCode: currency,
      declaredBase: Money.of(declared[0]?.total ?? '0', currency),
      totalAdjustments,
      losses: fromEvidence.losses,
      credits: fromEvidence.credits,
      amountPaid: fromEvidence.amountPaid,
      daysLate,
      filingDaysLate,
      assessmentYear: assessmentCase.assessmentYear,
    };
  }

  private async persist(
    caseId: number,
    statusCode: CaseStatus,
    result: CalculationResult,
    ruleSetId: number,
    inputsHash: string,
    caller: RequestContext,
  ): Promise<StoredCalculation> {
    return this.sequelize.transaction(async (transaction) => {
      const previous = await this.sequelize.query<{ max: string | null }>(
        `SELECT max(version)::text AS max FROM tax.tax_calculation_result WHERE case_id = :caseId`,
        { type: QueryTypes.SELECT, transaction, replacements: { caseId } },
      );
      const version = Number(previous[0]?.max ?? 0) + 1;

      // Demote the previous current row first: the partial unique index allows
      // exactly one current result per case, so this ordering matters.
      await this.sequelize.query(
        `UPDATE tax.tax_calculation_result SET is_current = false
          WHERE case_id = :caseId AND is_current`,
        { type: QueryTypes.UPDATE, transaction, replacements: { caseId } },
      );

      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.tax_calculation_result
                (case_id, version, rule_set_id, rule_set_version, inputs_hash,
                 declared_base, total_adjustments, assessed_base, losses_set_off,
                 taxable_base, tax_before_credits, surcharge_amount, total_credits,
                 tax_after_credits, penalty_amount, interest_amount, total_payable,
                 amount_paid, net_payable_or_refundable, currency_code,
                 is_current, calculated_by)
         VALUES (:caseId, :version, :ruleSetId, :ruleSetVersion, :inputsHash,
                 :declaredBase, :totalAdjustments, :assessedBase, :lossesSetOff,
                 :taxableBase, :taxBeforeCredits, :surchargeAmount, :totalCredits,
                 :taxAfterCredits, :penaltyAmount, :interestAmount, :totalPayable,
                 :amountPaid, :netPayable, :currency, true, :userId)
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            caseId,
            version,
            ruleSetId,
            ruleSetVersion: result.ruleSetVersion,
            inputsHash,
            // Every monetary value is bound as a string (ADR-007).
            declaredBase: result.declaredBase.toString(),
            totalAdjustments: result.totalAdjustments.toString(),
            assessedBase: result.assessedBase.toString(),
            lossesSetOff: result.lossesSetOff.toString(),
            taxableBase: result.taxableBase.toString(),
            taxBeforeCredits: result.taxBeforeCredits.toString(),
            surchargeAmount: result.surchargeAmount.toString(),
            totalCredits: result.totalCredits.toString(),
            taxAfterCredits: result.taxAfterCredits.toString(),
            penaltyAmount: result.penaltyAmount.toString(),
            interestAmount: result.interestAmount.toString(),
            totalPayable: result.totalPayable.toString(),
            amountPaid: result.amountPaid.toString(),
            netPayable: result.netPayableOrRefundable.toString(),
            currency: result.currencyCode,
            userId: currentUserId() ?? null,
          },
        },
      );

      const resultId = Number(rows[0]!['id']);

      for (const entry of result.trace) {
        await this.sequelize.query(
          `INSERT INTO tax.tax_calculation_trace
                  (result_id, sequence, step_code, description_key, expression,
                   inputs_json, output_value, rule_reference)
           VALUES (:resultId, :sequence, :step, :descriptionKey, :expression,
                   CAST(:inputs AS jsonb), :output, :ruleReference)`,
          {
            type: QueryTypes.INSERT,
            transaction,
            replacements: {
              resultId,
              sequence: entry.sequence,
              step: entry.step,
              descriptionKey: entry.descriptionKey,
              expression: entry.expression,
              inputs: JSON.stringify(entry.inputs),
              output: entry.output.toString(),
              ruleReference: entry.ruleReference ?? null,
            },
          },
        );
      }

      // Denormalised onto the case so the register can sort and filter on the
      // figure without joining every result row.
      await this.sequelize.query(
        `UPDATE tax.tax_assessment_case
            SET assessed_base = :assessedBase,
                net_payable = :netPayable,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = :caseId`,
        {
          type: QueryTypes.UPDATE,
          transaction,
          replacements: {
            caseId,
            assessedBase: result.assessedBase.toString(),
            netPayable: result.netPayableOrRefundable.toString(),
          },
        },
      );

      await this.cases.writeEvent(
        transaction,
        caseId,
        CaseEventType.CALCULATION_RUN,
        statusCode,
        null,
        caller,
        {
          version,
          ruleSetCode: result.ruleSetCode,
          ruleSetVersion: result.ruleSetVersion,
          inputsHash,
          // The figures themselves stay out of the ledger payload: it is read
          // by roles that may see a case was computed without seeing by how
          // much.
        },
      );

      this.logger.log(
        `Calculated case ${caseId} v${version} under ${result.ruleSetCode} ` +
          `v${result.ruleSetVersion}`,
      );

      return {
        ...toStored({ ...rows[0]!, rule_set_code: result.ruleSetCode }),
        trace: result.trace.map((entry) => ({
          sequence: entry.sequence,
          step: entry.step,
          descriptionKey: entry.descriptionKey,
          expression: entry.expression,
          output: entry.output.toString(),
          ruleReference: entry.ruleReference ?? null,
        })),
      };
    });
  }

  private async traceFor(resultId: number): Promise<StoredCalculation['trace']> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT sequence, step_code, description_key, expression, output_value, rule_reference
         FROM tax.tax_calculation_trace
        WHERE result_id = :resultId
        ORDER BY sequence`,
      { type: QueryTypes.SELECT, replacements: { resultId } },
    );

    return rows.map((row) => ({
      sequence: Number(row['sequence']),
      step: String(row['step_code']),
      descriptionKey: String(row['description_key']),
      expression: String(row['expression']),
      output: String(row['output_value']),
      ruleReference: row['rule_reference'] === null ? null : String(row['rule_reference']),
    }));
  }
}

function toStored(row: Record<string, unknown>): Omit<StoredCalculation, 'trace'> {
  return {
    id: Number(row['id']),
    version: Number(row['version']),
    ruleSetCode: String(row['rule_set_code']),
    ruleSetVersion: Number(row['rule_set_version']),
    inputsHash: String(row['inputs_hash']),
    declaredBase: String(row['declared_base']),
    totalAdjustments: String(row['total_adjustments']),
    assessedBase: String(row['assessed_base']),
    lossesSetOff: String(row['losses_set_off']),
    taxableBase: String(row['taxable_base']),
    taxBeforeCredits: String(row['tax_before_credits']),
    totalCredits: String(row['total_credits']),
    taxAfterCredits: String(row['tax_after_credits']),
    penaltyAmount: String(row['penalty_amount']),
    interestAmount: String(row['interest_amount']),
    totalPayable: String(row['total_payable']),
    netPayableOrRefundable: String(row['net_payable_or_refundable']),
    currencyCode: String(row['currency_code']),
    calculatedAt: row['calculated_at'] as Date,
  };
}
