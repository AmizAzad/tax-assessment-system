import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import { calculate } from './pipeline';
import { RuleSetService } from './rule-set.service';
import type { CalculationInputs } from './types';

export interface SimulationRequest {
  /** The draft rule set to try. */
  readonly draftRuleSetId: number;
  /** Limit the historic sample. Defaults to the most recent 500. */
  readonly limit?: number;
  readonly assessmentYear?: string;
}

export interface SimulationLine {
  readonly caseNumber: string;
  readonly tin: string;
  readonly currentNet: string;
  readonly simulatedNet: string;
  readonly movement: string;
  readonly direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED';
  readonly failed?: string;
}

export interface SimulationResult {
  readonly draftRuleSet: string;
  readonly comparedAgainst: string;
  readonly casesCompared: number;
  readonly casesFailed: number;
  readonly currency: string;
  readonly totalCurrent: string;
  readonly totalSimulated: string;
  readonly totalMovement: string;
  readonly increased: number;
  readonly decreased: number;
  readonly unchanged: number;
  /** The largest movements in both directions, which is what gets reviewed. */
  readonly biggestIncreases: readonly SimulationLine[];
  readonly biggestDecreases: readonly SimulationLine[];
}

/**
 * Replaying a draft rule set over historic cases.
 *
 * Plan reference: V2 sections 11.4, 11.5 (Phase 3).
 *
 * ## What this is for
 *
 * Publishing a rule set changes every case computed after it. The question
 * nobody can answer by reading a rate table is "what would this actually have
 * done": a fraction changed in the fourth decimal place can move a hundred
 * million, and a band boundary moved by a pound can move nobody at all.
 *
 * So the draft is run over real historic inputs and the movements are totalled
 * before anyone publishes it. This is the difference between a rate change
 * that was reviewed and one that was merely approved.
 *
 * ## Why it never writes
 *
 * Nothing here persists a calculation, and it deliberately does not reuse
 * `CalculationService.calculateForCase`, which does. A simulation that could
 * leave a figure on a case would be a way to change an assessment without
 * anybody approving it.
 *
 * ## Why it runs against a draft
 *
 * A published rule set is already in force; simulating it answers nothing.
 * Passing one is refused rather than quietly allowed, because the likely cause
 * is somebody comparing the wrong pair.
 */
@Injectable()
export class SimulatorService {
  private readonly logger = new Logger(SimulatorService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly ruleSets: RuleSetService,
  ) {}

  async simulate(request: SimulationRequest): Promise<SimulationResult> {
    const draft = await this.loadRuleSet(request.draftRuleSetId);

    if (draft.status !== 'DRAFT') {
      throw new BadRequestException(
        `Rule set ${draft.code} is ${draft.status}. Simulation compares a draft against what is ` +
          'in force; simulating a published set compares it with itself.',
      );
    }

    const sample = await this.historicSample(draft, request);
    if (sample.length === 0) {
      throw new BadRequestException(
        `No finalised cases found for ${draft.jurisdiction_code} ${draft.tax_type_code}` +
          `${request.assessmentYear === undefined ? '' : ` in ${request.assessmentYear}`}. ` +
          'There is nothing to replay the draft over.',
      );
    }

    const draftRuleSet = await this.ruleSets.findById(draft.id);
    const currency = draft.currency_code;
    const zero = Money.zero(currency);

    const lines: SimulationLine[] = [];
    let totalCurrent = zero;
    let totalSimulated = zero;
    let failed = 0;

    for (const row of sample) {
      const currentNet = Money.of(row.net_payable_or_refundable, currency);

      // Rebuilt from the stored result rather than re-gathered, so the
      // comparison isolates the rule change. Re-reading evidence would let a
      // source system that moved since finalisation show up as a rule effect.
      const inputs: CalculationInputs = {
        currencyCode: currency,
        declaredBase: Money.of(row.declared_base, currency),
        totalAdjustments: Money.of(row.total_adjustments, currency),
        losses: [],
        credits: [],
        amountPaid: zero,
        daysLate: row.days_late ?? 0,
        filingDaysLate: row.filing_days_late ?? 0,
        assessmentYear: row.assessment_year,
      };

      try {
        const simulated = calculate(inputs, draftRuleSet);
        const simulatedNet = simulated.netPayableOrRefundable;
        const movement = simulatedNet.subtract(currentNet);

        totalCurrent = totalCurrent.add(currentNet);
        totalSimulated = totalSimulated.add(simulatedNet);

        lines.push({
          caseNumber: row.case_number,
          tin: row.tin,
          currentNet: currentNet.toFixed(2),
          simulatedNet: simulatedNet.toFixed(2),
          movement: movement.toFixed(2),
          direction: movement.isZero()
            ? 'UNCHANGED'
            : movement.isPositive()
              ? 'INCREASE'
              : 'DECREASE',
        });
      } catch (error) {
        // A draft that cannot compute some historic case is itself the
        // finding. Recorded per case rather than aborting the run, because
        // "fails on 3 of 500" is far more useful than one stack trace.
        failed += 1;
        lines.push({
          caseNumber: row.case_number,
          tin: row.tin,
          currentNet: currentNet.toFixed(2),
          simulatedNet: '-',
          movement: '-',
          direction: 'UNCHANGED',
          failed: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const movements = lines.filter((line) => line.failed === undefined);
    const byMovement = [...movements].sort((a, b) => Number(b.movement) - Number(a.movement));

    this.logger.log(
      `Simulated ${draft.code} over ${sample.length} cases: ` +
        `${totalSimulated.subtract(totalCurrent).toFixed(2)} ${currency} movement, ${failed} failed`,
    );

    return {
      draftRuleSet: draft.code,
      comparedAgainst: 'the stored result of each finalised case',
      casesCompared: sample.length,
      casesFailed: failed,
      currency,
      totalCurrent: totalCurrent.toFixed(2),
      totalSimulated: totalSimulated.toFixed(2),
      totalMovement: totalSimulated.subtract(totalCurrent).toFixed(2),
      increased: movements.filter((l) => l.direction === 'INCREASE').length,
      decreased: movements.filter((l) => l.direction === 'DECREASE').length,
      unchanged: movements.filter((l) => l.direction === 'UNCHANGED').length,
      biggestIncreases: byMovement.slice(0, 10),
      biggestDecreases: byMovement.slice(-10).reverse(),
    };
  }

  private async loadRuleSet(id: number): Promise<{
    id: number;
    code: string;
    status: string;
    jurisdiction_code: string;
    tax_type_code: string;
    currency_code: string;
  }> {
    const rows = await this.sequelize.query<{
      id: number;
      code: string;
      status: string;
      jurisdiction_code: string;
      tax_type_code: string;
      currency_code: string;
    }>(
      `SELECT id, code, status, jurisdiction_code, tax_type_code, currency_code
         FROM tax.tax_rule_set WHERE id = :id AND is_active`,
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new BadRequestException(`Rule set ${id} was not found.`);
    }
    return row;
  }

  /**
   * Finalised cases with a stored result.
   *
   * Only finalised ones: a case still in preparation has no settled figure to
   * compare against, and including it would report movement that is really
   * just work in progress.
   */
  private async historicSample(
    draft: { jurisdiction_code: string; tax_type_code: string },
    request: SimulationRequest,
  ): Promise<
    readonly {
      case_number: string;
      tin: string;
      assessment_year: string;
      declared_base: string;
      total_adjustments: string;
      net_payable_or_refundable: string;
      days_late: number | null;
      filing_days_late: number | null;
    }[]
  > {
    return this.sequelize.query(
      `SELECT c.case_number, c.tin, c.assessment_year,
              r.declared_base::text AS declared_base,
              r.total_adjustments::text AS total_adjustments,
              r.net_payable_or_refundable::text AS net_payable_or_refundable,
              NULL::int AS days_late,
              NULL::int AS filing_days_late
         FROM tax.tax_assessment_case c
         JOIN tax.tax_calculation_result r ON r.case_id = c.id AND r.is_current
        WHERE c.is_active
          AND c.jurisdiction_code = :jurisdiction
          AND c.tax_type_code = :taxType
          AND c.finalised_at IS NOT NULL
          AND (:assessmentYear::text IS NULL OR c.assessment_year = :assessmentYear)
        ORDER BY c.finalised_at DESC
        LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          jurisdiction: draft.jurisdiction_code,
          taxType: draft.tax_type_code,
          assessmentYear: request.assessmentYear ?? null,
          limit: Math.min(request.limit ?? 500, 2000),
        },
      },
    );
  }
}
