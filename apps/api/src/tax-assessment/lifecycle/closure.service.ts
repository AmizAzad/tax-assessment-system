import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { Money } from '@tas/decimal';
import { randomUUID } from 'node:crypto';
import { QueryTypes, Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { JobRegistryService } from '../../platform/scheduling/job-registry.service';
import { CaseService } from '../case/case.service';

export interface CloseInput {
  readonly reasonCode: string;
  readonly narrative?: string;
  readonly retentionClass?: string;
}

export interface LegalHoldInput {
  readonly hold: boolean;
  readonly reason?: string;
}

/**
 * Closing a case, and deciding how long its file lives.
 *
 * Plan reference: V2 sections 14.4 to 14.6 (Phase 7, stage 14).
 *
 * ## Why closure writes a record rather than only a status
 *
 * `status_code = 'CLOSED'` says a case is over. It does not say why, who
 * decided, what the balance was, or when the file may be destroyed. Those are
 * the questions asked years later, usually by someone holding a complaint, and
 * by then the live tables have moved on.
 *
 * The balance is therefore **snapshotted** at closure. Recomputing it later
 * from payments and calculations would give whatever the current data says,
 * which is not what the file recorded at the time.
 *
 * ## Legal hold outranks retention
 *
 * A case under litigation must survive its own retention rule. A process that
 * deleted it on schedule would be destroying evidence, so the retention sweep
 * refuses to touch anything on hold, and lifting a hold is a FULL-level act
 * that has to give a reason.
 */
@Injectable()
export class ClosureService implements OnModuleInit {
  private readonly logger = new Logger(ClosureService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    private readonly jobs: JobRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.register('AUTO_CLOSURE', 'ta.job.autoClosure', 'daily at 02:00');
  }

  async close(
    caseId: number,
    input: CloseInput,
    caller: RequestContext,
    options: { auto?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const assessmentCase = await this.cases.findById(caseId);

    if (assessmentCase.statusCode === CaseStatus.CLOSED) {
      throw new ConflictException(`Case ${assessmentCase.caseNumber} is already closed.`);
    }

    await this.assertReasonExists(assessmentCase.jurisdictionCode, input.reasonCode);

    const balance = await this.balanceFor(caseId, assessmentCase.currencyCode);
    const retentionClass = input.retentionClass ?? 'STATUTORY';
    const retainUntil = await this.retainUntil(assessmentCase.jurisdictionCode, retentionClass);

    return this.sequelize.transaction(async (transaction) => {
      const rows = await this.sequelize.query<Record<string, unknown>>(
        `INSERT INTO tax.tax_case_closure
                (case_id, reason_code, narrative,
                 final_assessed_amount, final_paid_amount, final_balance, currency_code,
                 closed_by, closed_at, auto_closed,
                 retention_class, retain_until, legal_hold,
                 created_at, updated_at, is_active)
         VALUES (:caseId, :reasonCode, :narrative,
                 :assessed, :paid, :balance, :currency,
                 :userId, CURRENT_TIMESTAMP, :auto,
                 :retentionClass, :retainUntil::date, false,
                 CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true)
         RETURNING *`,
        {
          type: QueryTypes.SELECT,
          transaction,
          replacements: {
            caseId,
            reasonCode: input.reasonCode,
            narrative: input.narrative ?? null,
            assessed: balance.assessed.toDatabaseValue(),
            paid: balance.paid.toDatabaseValue(),
            balance: balance.outstanding.toDatabaseValue(),
            currency: assessmentCase.currencyCode,
            userId: caller.userId ?? null,
            auto: options.auto ?? false,
            retentionClass,
            retainUntil,
          },
        },
      );

      await this.cases.transition(caseId, 'CLOSE', caller, {
        reasonCode: input.reasonCode,
        finalBalance: balance.outstanding.toString(),
      });

      this.logger.log(
        `Case ${assessmentCase.caseNumber} closed (${input.reasonCode}); balance ` +
          `${balance.outstanding.toString()} ${assessmentCase.currencyCode}; retain until ` +
          `${retainUntil ?? 'indefinitely'}`,
      );
      return rows[0]!;
    });
  }

  async closureFor(caseId: number): Promise<Record<string, unknown>> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT reason_code, narrative,
              final_assessed_amount::text AS final_assessed_amount,
              final_paid_amount::text AS final_paid_amount,
              final_balance::text AS final_balance,
              currency_code, closed_at, auto_closed,
              retention_class, retain_until::text AS retain_until,
              legal_hold, legal_hold_reason
         FROM tax.tax_case_closure
        WHERE case_id = :caseId AND is_active`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(`Case ${caseId} has no closure record; it is not closed.`);
    }
    return row;
  }

  /**
   * Place or lift a legal hold.
   *
   * Both directions need a reason. Lifting one is the more dangerous act: it
   * returns a file to the destruction schedule, and whoever does it should
   * have to say on what basis the litigation risk ended.
   */
  async setLegalHold(
    caseId: number,
    input: LegalHoldInput,
    caller: RequestContext,
  ): Promise<Record<string, unknown>> {
    const reason = input.reason?.trim() ?? '';
    if (reason === '') {
      throw new BadRequestException(
        input.hold
          ? 'A legal hold must say what it is for, or nobody can tell when it may be lifted.'
          : 'Lifting a legal hold returns the file to the destruction schedule. Record why the ' +
              'hold is no longer needed.',
      );
    }

    const rows = await this.sequelize.query<Record<string, unknown>>(
      `UPDATE tax.tax_case_closure
          SET legal_hold = :hold,
              legal_hold_reason = :reason,
              updated_at = CURRENT_TIMESTAMP
        WHERE case_id = :caseId AND is_active
      RETURNING case_id, legal_hold, legal_hold_reason, retain_until::text AS retain_until`,
      {
        type: QueryTypes.SELECT,
        replacements: { caseId, hold: input.hold, reason },
      },
    );

    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundException(
        `Case ${caseId} has no closure record. A legal hold applies to a closed file.`,
      );
    }

    // Documents carry their own hold flag, because the destruction job that
    // walks object storage does not read the case tables.
    await this.sequelize.query(
      `UPDATE platform.document
          SET legal_hold = :hold, updated_at = CURRENT_TIMESTAMP
        WHERE owner_type IN ('ASSESSMENT_CASE', 'ASSESSMENT_NOTICE') AND owner_id = :caseId`,
      { type: QueryTypes.UPDATE, replacements: { caseId, hold: input.hold } },
    );

    this.logger.warn(
      `Legal hold ${input.hold ? 'placed on' : 'lifted from'} case ${caseId} by ` +
        `${caller.username ?? 'unknown'}: ${reason}`,
    );
    return row;
  }

  /**
   * Close settled cases that have been quiet long enough.
   *
   * Daily, not hourly: nothing here is time-critical, and a case that settles
   * today does not need closing tonight.
   *
   * Only `SETTLED` cases are swept. A case with an outstanding balance is
   * never auto-closed, because closing it would stop the authority chasing
   * money that is owed, and no scheduler should be able to do that.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async autoCloseSettled(): Promise<void> {
    // Exclusive across replicas: two instances closing the same case would
    // have one of them fail on the unique closure index, which is a confusing
    // way to discover a scheduling problem.
    await this.jobs.runExclusively('AUTO_CLOSURE', async () => {
      const rows = await this.sequelize.query<{ id: string; case_number: string }>(
        `SELECT c.id::text AS id, c.case_number
           FROM tax.tax_assessment_case c
          WHERE c.status_code = :settled
            AND c.is_active
            AND c.updated_at < CURRENT_TIMESTAMP - INTERVAL '30 days'
            AND NOT EXISTS (
              SELECT 1 FROM tax.tax_case_closure x
               WHERE x.case_id = c.id AND x.is_active)
          LIMIT 200`,
        { type: QueryTypes.SELECT, replacements: { settled: CaseStatus.SETTLED } },
      );

      let closed = 0;
      for (const row of rows) {
        try {
          await this.close(
            Number(row.id),
            {
              reasonCode: 'SETTLED_IN_FULL',
              narrative: 'Closed automatically: settled and quiet for 30 days.',
            },
            this.systemContext(),
            { auto: true },
          );
          closed += 1;
        } catch (error) {
          // One stuck case must not stop the sweep for every other case.
          this.logger.warn(
            `Could not auto-close ${row.case_number}: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }

      return closed === 0 ? undefined : `Auto-closed ${closed} settled case(s)`;
    });
  }

  /**
   * Files whose retention has expired and which are not on hold.
   *
   * Reports rather than deletes. Destroying a tax file is irreversible and in
   * most authorities needs a records officer to authorise a batch; a service
   * that quietly deleted on a timer would be a disaster with no undo. So this
   * produces the list, and disposal remains a deliberate act.
   */
  async disposalCandidates(): Promise<readonly Record<string, unknown>[]> {
    return this.sequelize.query<Record<string, unknown>>(
      `SELECT c.case_number, c.tin, x.reason_code, x.closed_at,
              x.retention_class, x.retain_until::text AS retain_until
         FROM tax.tax_case_closure x
         JOIN tax.tax_assessment_case c ON c.id = x.case_id
        WHERE x.is_active
          AND NOT x.legal_hold
          AND x.retain_until IS NOT NULL
          AND x.retain_until < CURRENT_DATE
        ORDER BY x.retain_until`,
      { type: QueryTypes.SELECT },
    );
  }

  // ------------------------------------------------------------------ internals

  /**
   * The position at closure, computed once and then frozen into the record.
   *
   * The calculation's net figure is net of the payments known when it ran.
   * Payments received afterwards -- which is most of them, since a taxpayer
   * pays after being told what to pay -- have to be taken off as well, or a
   * case paid in full closes with its full assessment still showing as the
   * balance. That is the same arithmetic `SettlementService` uses to decide
   * whether a case is settled, and the two must agree: a case cannot be
   * settled and simultaneously close owing money.
   */
  private async balanceFor(
    caseId: number,
    currency: string,
  ): Promise<{ assessed: Money; paid: Money; outstanding: Money }> {
    const rows = await this.sequelize.query<{ net: string | null }>(
      `SELECT net_payable_or_refundable::text AS net
         FROM tax.tax_calculation_result
        WHERE case_id = :caseId AND is_current`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    const assessed = Money.of(rows[0]?.net ?? '0', currency);

    const paidRows = await this.sequelize.query<{ total: string | null }>(
      `SELECT COALESCE(sum(e.amount), 0)::text AS total
         FROM tax.taxpayer_account_entry e
         JOIN tax.tax_assessment_case c ON c.id = :caseId
         JOIN tax.tax_calculation_result r ON r.case_id = c.id AND r.is_current
        WHERE e.taxpayer_id = c.taxpayer_id
          AND e.tax_type_code = c.tax_type_code
          AND e.assessment_year = c.assessment_year
          AND e.entry_type IN ('PAYMENT', 'ADVANCE_PAYMENT')
          AND e.is_active
          AND e.created_at > r.calculated_at`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );
    const paidSince = Money.of(paidRows[0]?.total ?? '0', currency);

    return { assessed, paid: paidSince, outstanding: assessed.subtract(paidSince) };
  }

  private async assertReasonExists(jurisdictionCode: string, reasonCode: string): Promise<void> {
    const rows = await this.sequelize.query<{ item_code: string }>(
      `SELECT i.item_code
         FROM platform.master_data_item i
         JOIN platform.master_data d ON d.id = i.master_data_id
        WHERE d.group_code = 'CLOSURE_REASON'
          AND d.jurisdiction_code = :jurisdiction
          AND i.item_code = :reasonCode
          AND d.is_active AND i.is_active`,
      { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode, reasonCode } },
    );

    if (rows.length === 0) {
      const available = await this.sequelize.query<{ item_code: string }>(
        `SELECT i.item_code
           FROM platform.master_data_item i
           JOIN platform.master_data d ON d.id = i.master_data_id
          WHERE d.group_code = 'CLOSURE_REASON' AND d.jurisdiction_code = :jurisdiction
            AND d.is_active AND i.is_active
          ORDER BY i.sort_order, i.item_code`,
        { type: QueryTypes.SELECT, replacements: { jurisdiction: jurisdictionCode } },
      );
      throw new BadRequestException(
        `'${reasonCode}' is not a closure reason configured for ${jurisdictionCode}. ` +
          `Configured reasons are: ${available.map((r) => r.item_code).join(', ') || '(none)'}.`,
      );
    }
  }

  /**
   * When the file may be destroyed.
   *
   * `retainYears` of zero means permanent, and returns null: a null retention
   * date is what the disposal query treats as "never", which is safer than a
   * date far in the future that some later arithmetic could reach.
   */
  private async retainUntil(
    jurisdictionCode: string,
    retentionClass: string,
  ): Promise<string | null> {
    const rows = await this.sequelize.query<{ attributes_json: { retainYears?: number } | null }>(
      `SELECT i.attributes_json
         FROM platform.master_data_item i
         JOIN platform.master_data d ON d.id = i.master_data_id
        WHERE d.group_code = 'RETENTION_CLASS'
          AND d.jurisdiction_code = :jurisdiction
          AND i.item_code = :retentionClass
          AND d.is_active AND i.is_active`,
      {
        type: QueryTypes.SELECT,
        replacements: { jurisdiction: jurisdictionCode, retentionClass },
      },
    );

    const years = rows[0]?.attributes_json?.retainYears;
    if (years === undefined) {
      this.logger.warn(
        `No retention period configured for ${retentionClass} in ${jurisdictionCode}. ` +
          'The file will be kept indefinitely, which is the safe default.',
      );
      return null;
    }
    if (years === 0) return null;

    const until = new Date();
    until.setUTCFullYear(until.getUTCFullYear() + years);
    return until.toISOString().slice(0, 10);
  }

  private systemContext(): RequestContext {
    return {
      roleCodes: [RoleCode.SYSTEM, RoleCode.SUPERVISOR],
      correlationId: randomUUID(),
      jurisdictionCode: 'SYSTEM',
      requestedAt: new Date(),
    };
  }
}
