import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { CaseEventType, isFrozenStatus } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { currentUserId } from '../../platform/auth/request-context';
import { CaseService } from './case.service';

export type AdjustmentDirection = 'ADD' | 'DEDUCT';

export interface AdjustmentInput {
  readonly adjustmentType: string;
  readonly reasonCode: string;
  readonly amount: string;
  readonly direction: AdjustmentDirection;
  readonly narrative?: string;
  readonly statutoryReference?: string;
  readonly officerOpinion?: string;
  readonly itemId?: number;
  readonly evidenceDocumentId?: number;
}

export interface AdjustmentRecord {
  readonly id: number;
  readonly adjustmentType: string;
  readonly reasonCode: string;
  readonly amount: string;
  readonly direction: AdjustmentDirection;
  readonly narrative: string | null;
  readonly status: string;
}

/**
 * Adjustments: the changes from declared to assessed.
 *
 * Plan reference: V2 sections 8.2 stage 4, 11.3, 13.4.
 *
 * ## Normalised rows, not only submission JSON
 *
 * The form submission is the authoring record — what the officer typed. These
 * rows are the computational and reporting record. Adjustments have to be
 * queryable per case, per reason code and per period for materiality and
 * adjustment-reason analysis, and recalculation must not depend on parsing a
 * form payload (plan 11.3).
 *
 * ## Materiality
 *
 * A narrative is mandatory above a configured threshold. An unexplained
 * five-figure adjustment is the kind of thing an objection is built on.
 */
@Injectable()
export class AdjustmentService {
  /**
   * Above this, a narrative is required.
   *
   * A placeholder default: in production this belongs in the rule set as
   * jurisdiction configuration, alongside the evidence threshold. Hard-coding
   * it here would make it a release to change.
   */
  private static readonly NARRATIVE_THRESHOLD = '1000';

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
  ) {}

  async add(
    caseId: number,
    input: AdjustmentInput,
    caller: RequestContext,
  ): Promise<AdjustmentRecord> {
    const assessmentCase = await this.cases.findById(caseId);

    if (isFrozenStatus(assessmentCase.statusCode)) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}. ` +
          `A finalised assessment cannot be adjusted — reassess it instead.`,
      );
    }

    const amount = this.parseAmount(input.amount, assessmentCase.currencyCode);

    if (!amount.isPositive()) {
      // Direction carries the sign. A negative amount plus DEDUCT would mean
      // an addition, which nobody reading the row would expect.
      throw new BadRequestException(
        'An adjustment amount must be positive. Use direction ADD or DEDUCT to say which way ' +
          'it moves the base.',
      );
    }

    const threshold = Money.of(AdjustmentService.NARRATIVE_THRESHOLD, assessmentCase.currencyCode);
    if (amount.greaterThan(threshold) && (input.narrative ?? '').trim() === '') {
      throw new BadRequestException(
        `An adjustment above ${threshold.toString()} ${assessmentCase.currencyCode} needs a ` +
          `narrative explaining it.`,
      );
    }

    return this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.tax_assessment_adjustment
                (case_id, item_id, adjustment_type, reason_code, statutory_reference,
                 amount, direction, narrative, officer_opinion, evidence_document_id,
                 proposed_by, status, created_by)
         VALUES (:caseId, :itemId, :adjustmentType, :reasonCode, :statutoryReference,
                 :amount, :direction, :narrative, :officerOpinion, :evidenceDocumentId,
                 :userId, 'PROPOSED', :userId)
         RETURNING id, adjustment_type, reason_code, amount, direction, narrative, status`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            caseId,
            itemId: input.itemId ?? null,
            adjustmentType: input.adjustmentType,
            reasonCode: input.reasonCode,
            statutoryReference: input.statutoryReference ?? null,
            // Bound as a string: the driver returns DECIMAL as a string and we
            // never let a monetary value become a JS number (ADR-007).
            amount: amount.toString(),
            direction: input.direction,
            narrative: input.narrative ?? null,
            officerOpinion: input.officerOpinion ?? null,
            evidenceDocumentId: input.evidenceDocumentId ?? null,
            userId: currentUserId() ?? null,
          },
        },
      );

      await this.cases.writeEvent(
        transaction,
        caseId,
        CaseEventType.ADJUSTMENT_RECORDED,
        null,
        null,
        caller,
        {
          adjustmentType: input.adjustmentType,
          reasonCode: input.reasonCode,
          direction: input.direction,
          // The amount is deliberately not in the event payload: the ledger is
          // read by roles who may see that a case was adjusted without seeing
          // the taxpayer's figures.
        },
      );

      return toAdjustment(rows[0]!);
    });
  }

  async remove(caseId: number, adjustmentId: number, caller: RequestContext): Promise<void> {
    const assessmentCase = await this.cases.findById(caseId);
    if (isFrozenStatus(assessmentCase.statusCode)) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode} and cannot be adjusted.`,
      );
    }

    await this.sequelize.transaction(async (transaction) => {
      // Soft delete. An adjustment that was proposed and withdrawn is part of
      // the case history: an objection may turn on it.
      const [, affected] = await this.sequelize.query(
        `UPDATE tax.tax_assessment_adjustment
            SET is_active = false, status = 'WITHDRAWN', updated_at = CURRENT_TIMESTAMP,
                updated_by = :userId
          WHERE id = :adjustmentId AND case_id = :caseId AND is_active`,
        {
          type: QueryTypes.UPDATE,
          transaction,
          replacements: { adjustmentId, caseId, userId: currentUserId() ?? null },
        },
      );

      if ((affected ?? 0) === 0) {
        throw new BadRequestException('No such adjustment on this case');
      }

      await this.cases.writeEvent(
        transaction,
        caseId,
        CaseEventType.ADJUSTMENT_RECORDED,
        null,
        null,
        caller,
        { adjustmentId, withdrawn: true },
      );
    });
  }

  async listFor(caseId: number): Promise<readonly AdjustmentRecord[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT id, adjustment_type, reason_code, amount, direction, narrative, status
         FROM tax.tax_assessment_adjustment
        WHERE case_id = :caseId AND is_active
        ORDER BY id`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    return rows.map(toAdjustment);
  }

  /**
   * The signed net of all live adjustments.
   *
   * ADD increases the base, DEDUCT reduces it. This is what feeds the
   * calculation pipeline's `totalAdjustments`.
   */
  async netTotal(caseId: number, currencyCode: string): Promise<Money> {
    const rows = await this.sequelize.query<{ amount: string; direction: string }>(
      `SELECT amount, direction FROM tax.tax_assessment_adjustment
        WHERE case_id = :caseId AND is_active AND status <> 'WITHDRAWN'`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    let total = Money.zero(currencyCode);
    for (const row of rows) {
      const amount = Money.of(row.amount, currencyCode);
      total = row.direction === 'DEDUCT' ? total.subtract(amount) : total.add(amount);
    }
    return total;
  }

  private parseAmount(raw: string, currency: string): Money {
    try {
      return Money.of(raw, currency);
    } catch {
      throw new BadRequestException(
        `'${raw}' is not a valid amount. Send it as a decimal string, e.g. "1250.00".`,
      );
    }
  }
}

function toAdjustment(row: Record<string, unknown>): AdjustmentRecord {
  return {
    id: Number(row['id']),
    adjustmentType: String(row['adjustment_type']),
    reasonCode: String(row['reason_code']),
    amount: String(row['amount']),
    direction: String(row['direction']) as AdjustmentDirection,
    narrative: row['narrative'] === null ? null : String(row['narrative']),
    status: String(row['status']),
  };
}
