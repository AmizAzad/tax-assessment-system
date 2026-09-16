import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { CaseService } from '../case/case.service';
import { today } from '../deadline/business-calendar';

export interface ReassessInput {
  readonly grounds: string;
  readonly triggerSource?: string;
  /** Required only when reaching back beyond the limitation date. */
  readonly limitationOverrideReason?: string;
}

export interface CalculationDelta {
  readonly from: number | null;
  readonly to: number;
  readonly currencyCode: string;
  readonly lines: readonly {
    label: string;
    previous: string;
    revised: string;
    movement: string;
  }[];
  readonly netMovement: string;
  readonly direction: 'INCREASE' | 'DECREASE' | 'UNCHANGED';
}

/**
 * Reassessing an assessment, and closing a case.
 *
 * Plan reference: V2 sections 14.1 to 14.6 (Phase 7).
 *
 * ## Two shapes, chosen by the case's own state
 *
 * A dispute outcome reassesses **in place**: the tribunal varied this
 * assessment, so the revised figure is a new version of it and the lineage is
 * the calculation chain.
 *
 * New information after closure opens a **successor case** pointing at its
 * predecessor. The original assessment was a completed legal act. It is not
 * reopened; it is succeeded. Collapsing the two would either lose the original
 * or pretend the new one amends something already spent.
 *
 * The caller does not choose. The case's status decides, because the status is
 * what determines which of those two things is legally available.
 *
 * ## Limitation
 *
 * Checked, recorded, and overridable only with a reason and an identified
 * authoriser. Some jurisdictions permit reaching back further where fraud is
 * alleged; none permit doing so silently.
 */
@Injectable()
export class ReassessmentService {
  private readonly logger = new Logger(ReassessmentService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
  ) {}

  async reassess(
    caseId: number,
    input: ReassessInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const assessmentCase = await this.cases.findById(caseId);

    if (input.grounds.trim().length < 10) {
      throw new BadRequestException(
        'A reassessment must state its grounds. Reopening a determination without a recorded ' +
          'reason is the thing this record exists to prevent.',
      );
    }

    const inPlace = IN_PLACE_STATUSES.includes(assessmentCase.statusCode);
    const successor = SUCCESSOR_STATUSES.includes(assessmentCase.statusCode);

    if (!inPlace && !successor) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}. A reassessment ` +
          'follows either a dispute outcome or a closed case; this case is still in progress.',
      );
    }

    const limitation = this.checkLimitation(assessmentCase.limitationDate, input);
    if (!limitation.within && limitation.overrideReason === undefined) {
      throw new ForbiddenException(
        `The limitation date for case ${assessmentCase.caseNumber} was ` +
          `${assessmentCase.limitationDate}. Reassessing beyond it requires an explicit ` +
          'limitationOverrideReason, and is only lawful on grounds such as fraud or deliberate ' +
          'concealment.',
      );
    }
    if (!limitation.within && caller.userId === undefined) {
      throw new ForbiddenException(
        'Reassessing outside the limitation period must be attributable to a person. The ' +
          'request carried no user identity.',
      );
    }

    return inPlace
      ? this.reassessInPlace(assessmentCase, input, limitation, caller)
      : this.openSuccessor(assessmentCase, input, limitation, caller);
  }

  /**
   * Continue the same case.
   *
   * The `REASSESS` transition is SYSTEM in the state machine, for the same
   * reason routing is: it follows from an outcome already recorded rather than
   * from anybody's decision at this point.
   */
  private async reassessInPlace(
    assessmentCase: {
      id: number;
      caseNumber: string;
      statusCode: string;
      currencyCode: string;
      limitationDate: string | null;
    },
    input: ReassessInput,
    limitation: { within: boolean; overrideReason?: string },
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    return this.sequelize.transaction(async (transaction) => {
      const previous = await this.currentCalculationId(assessmentCase.id, transaction);

      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.tax_reassessment
                (case_id, shape, trigger_source, grounds,
                 limitation_date, within_limitation, limitation_override_reason, authorised_by,
                 previous_calculation_id, currency_code, status,
                 created_at, created_by, updated_at, updated_by, is_active)
         VALUES (:caseId, 'IN_PLACE', :trigger, :grounds,
                 :limitationDate::date, :within, :overrideReason, :authorisedBy,
                 :previous, :currency, 'OPEN',
                 CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true)
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            caseId: assessmentCase.id,
            trigger: input.triggerSource ?? triggerFor(assessmentCase.statusCode),
            grounds: input.grounds,
            limitationDate: assessmentCase.limitationDate,
            within: limitation.within,
            overrideReason: limitation.overrideReason ?? null,
            authorisedBy: limitation.within ? null : (caller.userId ?? null),
            previous,
            currency: assessmentCase.currencyCode,
            userId: caller.userId ?? null,
          },
        },
      );

      await this.cases.transition(
        assessmentCase.id,
        'REASSESS',
        { ...caller, roleCodes: [RoleCode.SYSTEM] },
        { grounds: input.grounds, withinLimitation: limitation.within },
      );

      this.logger.log(
        `Case ${assessmentCase.caseNumber} reassessed in place` +
          (limitation.within ? '' : ' OUTSIDE the limitation period'),
      );
      return { ...rows[0]!, shape: 'IN_PLACE' };
    });
  }

  /**
   * Open a successor case.
   *
   * Prefilled from the predecessor, because the taxpayer, tax type, period and
   * currency are the same facts and retyping them is how they diverge.
   */
  private async openSuccessor(
    predecessor: {
      id: number;
      caseNumber: string;
      taxpayerId: number;
      taxTypeCode: string;
      jurisdictionCode: string;
      assessmentYear: string;
      currencyCode: string;
      limitationDate: string | null;
    },
    input: ReassessInput,
    limitation: { within: boolean; overrideReason?: string },
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const successor = await this.cases.create(
      {
        taxpayerId: predecessor.taxpayerId,
        taxTypeCode: predecessor.taxTypeCode,
        assessmentYear: predecessor.assessmentYear,
        assessmentType: 'REASSESSMENT',
        triggerPath: 'NEW_INFORMATION',
        jurisdictionCode: predecessor.jurisdictionCode,
        currencyCode: predecessor.currencyCode,
        limitationDate: predecessor.limitationDate ?? undefined,
      },
      caller,
    );

    await this.sequelize.query(
      `UPDATE tax.tax_assessment_case
          SET predecessor_case_id = :predecessorId, updated_at = CURRENT_TIMESTAMP
        WHERE id = :caseId`,
      {
        type: QueryTypes.UPDATE,
        replacements: { predecessorId: predecessor.id, caseId: successor.id },
      },
    );

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `INSERT INTO tax.tax_reassessment
              (case_id, predecessor_case_id, shape, trigger_source, grounds,
               limitation_date, within_limitation, limitation_override_reason, authorised_by,
               currency_code, status, created_at, created_by, updated_at, updated_by, is_active)
       VALUES (:caseId, :predecessorId, 'SUCCESSOR', :trigger, :grounds,
               :limitationDate::date, :within, :overrideReason, :authorisedBy,
               :currency, 'OPEN', CURRENT_TIMESTAMP, :userId, CURRENT_TIMESTAMP, :userId, true)
       RETURNING *`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          caseId: successor.id,
          predecessorId: predecessor.id,
          trigger: input.triggerSource ?? 'NEW_INFORMATION',
          grounds: input.grounds,
          limitationDate: predecessor.limitationDate,
          within: limitation.within,
          overrideReason: limitation.overrideReason ?? null,
          authorisedBy: limitation.within ? null : (caller.userId ?? null),
          currency: predecessor.currencyCode,
          userId: caller.userId ?? null,
        },
      },
    );

    this.logger.log(
      `Case ${successor.caseNumber} opened as a successor to ${predecessor.caseNumber}` +
        (limitation.within ? '' : ' OUTSIDE the limitation period'),
    );

    return { ...rows[0]!, shape: 'SUCCESSOR', successorCase: successor };
  }

  /**
   * What changed between the two most recent calculation versions.
   *
   * The question a reviewer asks about any reassessment, and the one a
   * taxpayer asks about any revised notice. Computed through `Money`, so the
   * movements are exact rather than accumulated float error.
   */
  async delta(caseId: number): Promise<CalculationDelta> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT version, currency_code,
              declared_base::text AS declared_base,
              total_adjustments::text AS total_adjustments,
              taxable_base::text AS taxable_base,
              tax_before_credits::text AS tax_before_credits,
              total_credits::text AS total_credits,
              tax_after_credits::text AS tax_after_credits,
              penalty_amount::text AS penalty_amount,
              interest_amount::text AS interest_amount,
              net_payable_or_refundable::text AS net_payable_or_refundable
         FROM tax.tax_calculation_result
        WHERE case_id = :caseId
        ORDER BY version DESC
        LIMIT 2`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    const revised = rows[0];
    if (revised === undefined) {
      throw new NotFoundException(`Case ${caseId} has no calculation to compare.`);
    }

    const previous = rows[1];
    const currency = String(revised['currency_code']);
    const zero = Money.zero(currency);

    const lines = COMPARED_LINES.map(({ column, label }) => {
      const before =
        previous === undefined ? zero : Money.of(String(previous[column] ?? '0'), currency);
      const after = Money.of(String(revised[column] ?? '0'), currency);
      return {
        label,
        previous: before.toFixed(2),
        revised: after.toFixed(2),
        movement: after.subtract(before).toFixed(2),
      };
    });

    const beforeNet =
      previous === undefined
        ? zero
        : Money.of(String(previous['net_payable_or_refundable'] ?? '0'), currency);
    const afterNet = Money.of(String(revised['net_payable_or_refundable'] ?? '0'), currency);
    const movement = afterNet.subtract(beforeNet);

    return {
      from: previous === undefined ? null : Number(previous['version']),
      to: Number(revised['version']),
      currencyCode: currency,
      lines,
      netMovement: movement.toFixed(2),
      direction: movement.isZero() ? 'UNCHANGED' : movement.isPositive() ? 'INCREASE' : 'DECREASE',
    };
  }

  async historyFor(caseId: number): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT r.uuid, r.shape, r.trigger_source, r.grounds,
              r.within_limitation, r.limitation_date::text AS limitation_date,
              r.limitation_override_reason, r.status, r.created_at,
              p.case_number AS predecessor_case_number
         FROM tax.tax_reassessment r
         LEFT JOIN tax.tax_assessment_case p ON p.id = r.predecessor_case_id
        WHERE r.case_id = :caseId AND r.is_active
        ORDER BY r.id DESC`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
  }

  /**
   * The whole chain, in both directions.
   *
   * A recursive walk rather than a single join, because a period can be
   * assessed more than twice and "show me every assessment of 2024" must not
   * depend on how many times it happened.
   */
  async lineage(caseId: number): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `WITH RECURSIVE back AS (
         SELECT c.* FROM tax.tax_assessment_case c WHERE c.id = :caseId
         UNION ALL
         SELECT p.* FROM tax.tax_assessment_case p
           JOIN back b ON p.id = b.predecessor_case_id
       ), forward AS (
         SELECT c.* FROM tax.tax_assessment_case c WHERE c.id = :caseId
         UNION ALL
         SELECT s.* FROM tax.tax_assessment_case s
           JOIN forward f ON s.predecessor_case_id = f.id
       )
       SELECT DISTINCT id, case_number, status_code, assessment_type,
              assessment_year, predecessor_case_id,
              net_payable::text AS net_payable, opened_at
         FROM (SELECT * FROM back UNION SELECT * FROM forward) chain
        ORDER BY opened_at`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
  }

  // ------------------------------------------------------------------ internals

  /**
   * Is the reassessment within time?
   *
   * A case with no limitation date is treated as within time rather than out
   * of it: the absence of a configured limit is not a bar, and refusing here
   * would block reassessment in any jurisdiction that has not configured one.
   */
  private checkLimitation(
    limitationDate: string | null,
    input: ReassessInput,
  ): { within: boolean; overrideReason?: string } {
    if (limitationDate === null) return { within: true };

    const within = today() <= limitationDate.slice(0, 10);
    if (within) return { within: true };

    const reason = input.limitationOverrideReason?.trim();
    return { within: false, overrideReason: reason === '' ? undefined : reason };
  }

  private async currentCalculationId(
    caseId: number,
    transaction: Transaction,
  ): Promise<number | null> {
    const rows = await this.sequelize.query<{ id: string }>(
      `SELECT id::text AS id FROM tax.tax_calculation_result
        WHERE case_id = :caseId AND is_current`,
      { type: QueryTypes.SELECT, transaction, replacements: { caseId } },
    );
    return rows[0] === undefined ? null : Number(rows[0].id);
  }
}

/**
 * Statuses from which the same case may be reassessed.
 *
 * All of them are dispute outcomes. The state machine defines `REASSESS` only
 * from these, so this list and the transition table have to agree; the
 * transition would refuse anything else anyway, but failing here gives a
 * message that explains itself.
 */
const IN_PLACE_STATUSES: readonly string[] = [
  CaseStatus.OBJECTION_ALLOWED,
  CaseStatus.OBJECTION_PARTLY_ALLOWED,
  CaseStatus.APPEAL_VARIED,
  CaseStatus.APPEAL_REMANDED,
];

/** Statuses from which a successor case may be opened on new information. */
const SUCCESSOR_STATUSES: readonly string[] = [
  CaseStatus.CLOSED,
  CaseStatus.SETTLED,
  CaseStatus.WRITTEN_OFF,
];

function triggerFor(status: string): string {
  if (status === CaseStatus.APPEAL_VARIED || status === CaseStatus.APPEAL_REMANDED) {
    return 'APPEAL_DECISION';
  }
  return 'OBJECTION_DECISION';
}

/** The lines a delta shows, in the order a reviewer reads them. */
const COMPARED_LINES: readonly { column: string; label: string }[] = [
  { column: 'declared_base', label: 'Declared' },
  { column: 'total_adjustments', label: 'Adjustments' },
  { column: 'taxable_base', label: 'Taxable base' },
  { column: 'tax_before_credits', label: 'Tax before credits' },
  { column: 'total_credits', label: 'Credits' },
  { column: 'tax_after_credits', label: 'Tax after credits' },
  { column: 'penalty_amount', label: 'Penalty' },
  { column: 'interest_amount', label: 'Interest' },
  { column: 'net_payable_or_refundable', label: 'Net payable' },
];
