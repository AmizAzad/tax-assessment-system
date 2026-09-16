import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import { DeadlineService } from './deadline.service';
import { today } from './business-calendar';

export interface SlaClock {
  readonly slaCode: string;
  readonly stageCode: string | null;
  readonly startedAt: Date;
  readonly targetAt: string;
  readonly completedAt: Date | null;
  readonly status: string;
  readonly daysRemaining: number | null;
}

/**
 * Internal processing clocks.
 *
 * Plan reference: V2 sections 10.5, 21.2.
 *
 * ## Distinct from statutory deadlines, on purpose
 *
 * A deadline in `tax_assessment_deadline` is a date a taxpayer is bound by. An
 * SLA is a target the authority sets for itself. Conflating them would let an
 * internal target breach and look like a legal one, or let a missed service
 * standard be argued as a time bar. They are separate tables, separate
 * configuration, and separate reporting for that reason.
 *
 * ## Why clocks are driven from transitions
 *
 * A clock has to start when a case enters a stage and stop when it leaves.
 * Nothing else knows that moment. `CaseService.transition` is the single
 * writer of `status_code`, so it is the only place that can honestly say a
 * stage began.
 *
 * Before this service existed, `tax_sla_tracker` and its sweeper were both in
 * place and no row was ever created: the sweeper watched an empty table.
 */
@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly deadlines: DeadlineService,
  ) {}

  /**
   * Apply a status change to this case's clocks.
   *
   * Stops whatever the case was in, then starts whatever it has entered. In
   * that order: a configuration where one stage's stop status is another's
   * start would otherwise close the clock it had just opened.
   *
   * Runs inside the transition's own transaction, so a case never moves
   * without its clocks moving with it.
   */
  async applyTransition(
    caseId: number,
    scope: { jurisdictionCode: string; taxTypeCode: string },
    fromStatus: string | null,
    toStatus: string,
    userId: number | undefined,
    transaction: Transaction,
  ): Promise<void> {
    await this.stopClocks(caseId, fromStatus, toStatus, transaction);
    await this.startClocks(caseId, scope, toStatus, userId, transaction);
  }

  /** The clocks on a case, for the workbench. */
  async forCase(caseId: number): Promise<readonly SlaClock[]> {
    const rows = await this.sequelize.query<Record<string, unknown>>(
      `SELECT sla_code, stage_code, started_at, target_at::text AS target_at,
              completed_at, status,
              CASE WHEN status = 'RUNNING'
                   THEN EXTRACT(DAY FROM (target_at - CURRENT_TIMESTAMP))::int
                   ELSE NULL END AS days_remaining
         FROM tax.tax_sla_tracker
        WHERE case_id = :caseId AND is_active
        ORDER BY started_at`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    return rows.map((row) => ({
      slaCode: String(row['sla_code']),
      stageCode: (row['stage_code'] as string | null) ?? null,
      startedAt: row['started_at'] as Date,
      targetAt: String(row['target_at']),
      completedAt: (row['completed_at'] as Date | null) ?? null,
      status: String(row['status']),
      daysRemaining: row['days_remaining'] === null ? null : Number(row['days_remaining']),
    }));
  }

  // ------------------------------------------------------------------ internals

  /**
   * Close any running clock whose stage the case has left.
   *
   * A clock with a `stop_status` closes only on that status; one without
   * closes on any move out of its stage. `MET` or `BREACHED` is decided from
   * the target rather than from whether the sweeper had got to it yet, so a
   * case completed a minute after its target is honestly recorded as late.
   */
  private async stopClocks(
    caseId: number,
    fromStatus: string | null,
    toStatus: string,
    transaction: Transaction,
  ): Promise<void> {
    if (fromStatus === null) return;

    await this.sequelize.query(
      `UPDATE tax.tax_sla_tracker t
          SET completed_at = CURRENT_TIMESTAMP,
              status = CASE WHEN CURRENT_TIMESTAMP <= t.target_at THEN 'MET' ELSE 'BREACHED' END,
              breached_at = CASE WHEN CURRENT_TIMESTAMP > t.target_at
                                 THEN COALESCE(t.breached_at, CURRENT_TIMESTAMP)
                                 ELSE t.breached_at END,
              updated_at = CURRENT_TIMESTAMP
         FROM tax.tax_sla_config c
        WHERE t.case_id = :caseId
          AND t.status = 'RUNNING'
          AND t.is_active
          AND c.sla_code = t.sla_code
          AND c.is_active
          AND c.from_status = :fromStatus
          AND (c.stop_status IS NULL OR c.stop_status = :toStatus)`,
      {
        type: QueryTypes.UPDATE,
        transaction,
        replacements: { caseId, fromStatus, toStatus },
      },
    );
  }

  /** Start a clock for the stage the case has entered, if one is configured. */
  private async startClocks(
    caseId: number,
    scope: { jurisdictionCode: string; taxTypeCode: string },
    toStatus: string,
    userId: number | undefined,
    transaction: Transaction,
  ): Promise<void> {
    const configs = await this.sequelize.query<{
      sla_code: string;
      target_value: number;
      target_unit: string;
      calendar_rule: string;
    }>(
      `SELECT sla_code, target_value, target_unit, calendar_rule
         FROM tax.tax_sla_config
        WHERE jurisdiction_code = :jurisdiction
          AND (tax_type_code IS NULL OR tax_type_code = :taxType)
          AND from_status = :toStatus
          AND is_active`,
      {
        type: QueryTypes.SELECT,
        transaction,
        replacements: {
          jurisdiction: scope.jurisdictionCode,
          taxType: scope.taxTypeCode,
          toStatus,
        },
      },
    );

    for (const config of configs) {
      // Through the deadline engine, so a working-day service target honours
      // the same holiday calendar every statutory date uses.
      const targetDate = await this.deadlines.applyOffsetFor(scope.jurisdictionCode, today(), {
        offsetValue: config.target_value,
        offsetUnit: config.target_unit as 'DAYS' | 'MONTHS' | 'YEARS',
        calendarRule: config.calendar_rule as 'CALENDAR_DAYS' | 'BUSINESS_DAYS',
      });

      await this.sequelize.query(
        `INSERT INTO tax.tax_sla_tracker
                (case_id, sla_code, stage_code, started_at, target_at, status,
                 owner_user_id, created_at, updated_at, is_active)
         SELECT :caseId, :slaCode, :stage, CURRENT_TIMESTAMP, :targetAt::date, 'RUNNING',
                :userId, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, true
          WHERE NOT EXISTS (
            SELECT 1 FROM tax.tax_sla_tracker
             WHERE case_id = :caseId AND sla_code = :slaCode
               AND status = 'RUNNING' AND is_active)`,
        {
          type: QueryTypes.INSERT,
          transaction,
          replacements: {
            caseId,
            slaCode: config.sla_code,
            stage: toStatus,
            targetAt: targetDate,
            userId: userId ?? null,
          },
        },
      );
    }
  }
}
