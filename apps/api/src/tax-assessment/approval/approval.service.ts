import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { CaseService } from '../case/case.service';

export interface ApprovalRouting {
  readonly caseId: number;
  readonly statusCode: string;
  readonly amount: string;
  readonly currencyCode: string;
  readonly requiredRoleCode: string;
  readonly requiredApprovals: number;
  /** Why this band was chosen, for the case file. */
  readonly derivation: string;
}

interface ThresholdRow {
  readonly required_role_code: string;
  readonly required_approvals: number;
  readonly amount_from: string;
  readonly amount_to: string | null;
}

/**
 * Routing a reviewed assessment to the right approver, and finalising it.
 *
 * Plan reference: V2 sections 11.2 to 11.5.
 *
 * ## Why these are services rather than buttons
 *
 * `ROUTE_APPROVAL` and `FINALISE` are SYSTEM actions in the transition table.
 * Neither is a judgement a person makes: routing follows the delegation limits
 * from the amount, and finalisation follows from an approval already recorded.
 * Making them SYSTEM means nobody can route their own case to a friendlier
 * approver, or finalise one that was never approved.
 *
 * The endpoints that reach this service are permissioned, so a person still
 * asks for the step. What they cannot do is choose its outcome.
 *
 * ## What finalisation does that a status change does not
 *
 * Finalising consumes the losses the calculation relied on. Until then a loss
 * is still available to any other case, and two assessments prepared in
 * parallel could each relieve the same loss in full. The consumption happens
 * in the same transaction as the status change, under a row lock.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
  ) {}

  /**
   * Decide who must approve, and move the case to PENDING_APPROVAL.
   *
   * The amount that drives the band is the net payable, which is what the
   * authority is actually demanding. Using the taxable base instead would
   * route a large loss-relieved case to a senior approver over a figure nobody
   * is being asked to pay.
   */
  async route(caseId: number, caller: RequestContext): Promise<ApprovalRouting> {
    const assessmentCase = await this.cases.findById(caseId);

    if (assessmentCase.statusCode !== CaseStatus.REVIEWED) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}. Only a reviewed ` +
          'case can be routed for approval.',
      );
    }

    const current = await this.currentResult(caseId);
    if (current === undefined) {
      // Routing without a figure would ask an approver to approve nothing.
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} has no current calculation. Recalculate before ` +
          'routing it for approval.',
      );
    }

    const amount = Money.of(current.net_payable_or_refundable, current.currency_code);
    const band = await this.bandFor(assessmentCase, amount);

    const systemContext: RequestContext = { ...caller, roleCodes: [RoleCode.SYSTEM] };
    const updated = await this.cases.transition(caseId, 'ROUTE_APPROVAL', systemContext, {
      requiredRoleCode: band.required_role_code,
      requiredApprovals: band.required_approvals,
      amount: amount.toString(),
      routedBy: caller.username ?? 'system',
    });

    const upper = band.amount_to === null ? 'no ceiling' : band.amount_to;
    const derivation =
      `Net payable ${amount.toString()} ${current.currency_code} falls in the band ` +
      `${band.amount_from} to ${upper}, which requires ${band.required_approvals} approval(s) ` +
      `at ${band.required_role_code}.`;

    this.logger.log(`Case ${caseId} routed for approval: ${derivation}`);

    return {
      caseId,
      statusCode: updated.statusCode,
      amount: amount.toString(),
      currencyCode: current.currency_code,
      requiredRoleCode: band.required_role_code,
      requiredApprovals: band.required_approvals,
      derivation,
    };
  }

  /**
   * Finalise an approved assessment.
   *
   * The point of no return: after this the figures are the legal determination
   * and the calculation endpoint refuses to recompute them.
   */
  async finalise(caseId: number, caller: RequestContext): Promise<Record<string, unknown>> {
    const assessmentCase = await this.cases.findById(caseId);

    if (assessmentCase.statusCode !== CaseStatus.APPROVED) {
      throw new ConflictException(
        `Case ${assessmentCase.caseNumber} is ${assessmentCase.statusCode}. Only an approved ` +
          'case can be finalised.',
      );
    }

    const systemContext: RequestContext = { ...caller, roleCodes: [RoleCode.SYSTEM] };

    const consumed = await this.sequelize.transaction(async (transaction) =>
      this.consumeLosses(caseId, assessmentCase.taxpayerId, transaction),
    );

    const updated = await this.cases.transition(caseId, 'FINALISE', systemContext, {
      finalisedBy: caller.username ?? 'system',
      lossesConsumed: consumed.total,
    });

    return {
      caseId,
      statusCode: updated.statusCode,
      lossesConsumed: consumed.total,
      lossUtilisations: consumed.utilisations,
    };
  }

  /** The delegation bands, for the administration screen. */
  async thresholds(jurisdiction?: string): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT jurisdiction_code, tax_type_code,
              amount_from::text AS amount_from,
              amount_to::text   AS amount_to,
              currency_code, required_role_code, required_approvals,
              effective_from, effective_to
         FROM tax.tax_approval_threshold
        WHERE is_active
          AND (:jurisdiction::text IS NULL OR jurisdiction_code = :jurisdiction)
        ORDER BY jurisdiction_code, tax_type_code, amount_from`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdiction ?? null } },
    );
  }

  private async currentResult(
    caseId: number,
  ): Promise<{ net_payable_or_refundable: string; currency_code: string } | undefined> {
    const rows = await this.sequelize.query<{
      net_payable_or_refundable: string;
      currency_code: string;
    }>(
      `SELECT net_payable_or_refundable::text AS net_payable_or_refundable, currency_code
         FROM tax.tax_calculation_result
        WHERE case_id = :caseId AND is_current`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    return rows[0];
  }

  /**
   * The band the amount falls into.
   *
   * Matched on the absolute amount: a large refund needs the same seniority as
   * a large demand, because paying money out wrongly is at least as serious as
   * asking for it wrongly.
   */
  private async bandFor(
    assessmentCase: { jurisdictionCode: string; taxTypeCode: string; caseNumber: string },
    amount: Money,
  ): Promise<ThresholdRow> {
    const magnitude = amount.abs();

    const rows = await this.sequelize.query<ThresholdRow>(
      `SELECT required_role_code, required_approvals,
              amount_from::text AS amount_from, amount_to::text AS amount_to
         FROM tax.tax_approval_threshold
        WHERE jurisdiction_code = :jurisdiction
          AND tax_type_code = :taxType
          AND is_active
          AND amount_from <= :amount
          AND (amount_to IS NULL OR amount_to > :amount)
        ORDER BY amount_from DESC
        LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          jurisdiction: assessmentCase.jurisdictionCode,
          taxType: assessmentCase.taxTypeCode,
          amount: magnitude.toDatabaseValue(),
        },
      },
    );

    const band = rows[0];
    if (band === undefined) {
      // Falling back to the most senior approver would look safe and would be
      // wrong: it hides a configuration gap behind a behaviour nobody chose.
      throw new ConflictException(
        `No approval band covers ${magnitude.toString()} for ` +
          `${assessmentCase.jurisdictionCode} ${assessmentCase.taxTypeCode}. Configure the ` +
          'delegation limits before routing this case.',
      );
    }
    return band;
  }

  /**
   * Consume the losses this case's current calculation relied on.
   *
   * `FOR UPDATE` on the loss rows. Two cases finalising at the same moment
   * would otherwise both read the same remaining balance and both relieve it,
   * and the CHECK constraint would reject the second write rather than the
   * second read, leaving whichever lost the race with a confusing failure at
   * the very end of the approval chain.
   *
   * ## Reassessment releases before it consumes
   *
   * A case can be finalised more than once: a tribunal varies an assessment,
   * the figures are reworked, and the revised assessment is finalised in turn.
   * The superseded calculation's loss usage has to be released first, or the
   * case double-counts against its own earlier self and no in-place
   * reassessment involving losses could ever be finalised.
   *
   * Releasing is scoped to this case's own utilisations. Another case's relief
   * is not this case's to give back.
   */
  private async consumeLosses(
    caseId: number,
    taxpayerId: number,
    transaction: Transaction,
  ): Promise<{ total: string; utilisations: readonly Record<string, unknown>[] }> {
    // Release what this case relieved under any superseded calculation, so the
    // figures below start from the position as if this case had never run.
    const released = await this.sequelize.query<{ loss_id: string; amount_used: string }>(
      `UPDATE tax.tax_loss_utilisation
          SET is_active = false
        WHERE case_id = :caseId AND is_active
      RETURNING loss_id::text AS loss_id, amount_used::text AS amount_used`,
      { type: QueryTypes.SELECT, transaction, replacements: { caseId } },
    );

    for (const row of released) {
      await this.sequelize.query(
        `UPDATE tax.taxpayer_loss
            SET consumed_amount = consumed_amount - :amount, updated_at = CURRENT_TIMESTAMP
          WHERE id = :lossId`,
        {
          type: QueryTypes.UPDATE,
          transaction,
          replacements: { amount: row.amount_used, lossId: row.loss_id },
        },
      );
    }

    if (released.length > 0) {
      this.logger.log(
        `Case ${caseId}: released ${released.length} prior loss utilisation(s) before ` +
          'applying the revised calculation',
      );
    }

    const traceRows = await this.sequelize.query<{ output: string; currency_code: string }>(
      `SELECT t.output_value::text AS output, r.currency_code
         FROM tax.tax_calculation_trace t
         JOIN tax.tax_calculation_result r ON r.id = t.result_id
        WHERE r.case_id = :caseId AND r.is_current AND t.step_code = 'LOSS_SET_OFF'
        ORDER BY t.sequence`,
      { type: QueryTypes.SELECT, transaction, replacements: { caseId } },
    );

    const first = traceRows[0];
    if (first === undefined) {
      return { total: '0', utilisations: [] };
    }

    const currency = first.currency_code;
    let remaining = Money.of(first.output, currency);
    if (!remaining.isPositive()) {
      return { total: Money.zero(currency).toString(), utilisations: [] };
    }

    const losses = await this.sequelize.query<{
      id: string;
      origin_year: string;
      available: string;
    }>(
      `SELECT id::text AS id, origin_year,
              (original_amount - consumed_amount)::text AS available
         FROM tax.taxpayer_loss
        WHERE taxpayer_id = :taxpayerId
          AND original_amount > consumed_amount
          AND is_active
        ORDER BY origin_year, id
          FOR UPDATE`,
      { type: QueryTypes.SELECT, transaction, replacements: { taxpayerId } },
    );

    const utilisations: Record<string, unknown>[] = [];
    let sequence = 0;

    for (const loss of losses) {
      if (!remaining.isPositive()) break;

      const available = Money.of(loss.available, currency);
      // Oldest first, and never more than is left of either side.
      const used = Money.min(available, remaining);
      if (!used.isPositive()) continue;

      sequence += 1;
      await this.sequelize.query(
        `UPDATE tax.taxpayer_loss
            SET consumed_amount = consumed_amount + :used, updated_at = CURRENT_TIMESTAMP
          WHERE id = :lossId`,
        {
          type: QueryTypes.UPDATE,
          transaction,
          replacements: { used: used.toDatabaseValue(), lossId: loss.id },
        },
      );

      await this.sequelize.query(
        `INSERT INTO tax.tax_loss_utilisation
                (loss_id, case_id, amount_used, currency_code, sequence, created_at, is_active)
         VALUES (:lossId, :caseId, :used, :currency, :sequence, CURRENT_TIMESTAMP, true)`,
        {
          type: QueryTypes.INSERT,
          transaction,
          replacements: {
            lossId: loss.id,
            caseId,
            used: used.toDatabaseValue(),
            currency,
            sequence,
          },
        },
      );

      utilisations.push({
        lossId: Number(loss.id),
        originYear: loss.origin_year,
        amountUsed: used.toString(),
      });
      remaining = remaining.subtract(used);
    }

    if (remaining.isPositive()) {
      // The calculation relieved more loss than the account holds. That means
      // the snapshot and the account have diverged since retrieval, and
      // finalising would record relief the taxpayer is not entitled to.
      throw new ConflictException(
        `The assessment relieves ${remaining.toString()} ${currency} more loss than remains on ` +
          'the taxpayer account. Refresh the evidence and recalculate before finalising.',
      );
    }

    return {
      total: Money.of(first.output, currency).toString(),
      utilisations,
    };
  }
}
