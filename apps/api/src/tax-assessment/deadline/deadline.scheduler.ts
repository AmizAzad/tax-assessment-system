import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CaseStatus, RoleCode } from '@tas/contracts';
import { QueryTypes, Sequelize } from 'sequelize';
import { randomUUID } from 'node:crypto';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../../platform/auth/request-context';
import { NotificationService } from '../../platform/notification/notification.service';
import { JobRegistryService } from '../../platform/scheduling/job-registry.service';
import { CaseService } from '../case/case.service';

/**
 * Watching the clocks.
 *
 * Plan reference: V2 sections 10.5, 12.6 (Phase 5).
 *
 * ## Why deadlines need a sweeper at all
 *
 * A materialised deadline is a row with a due date. Nothing about storing it
 * makes anything happen when it passes. The consequences of a deadline
 * expiring are real — an objection window closing, a limitation period
 * running out, a case becoming time-barred — and they must occur whether or
 * not anybody opened the case that day.
 *
 * ## Why the effects are so conservative
 *
 * This job changes case state without a human in the loop, so it does the
 * smallest set of things that are unambiguous:
 *
 * - marks a passed deadline BREACHED,
 * - warns before one passes,
 * - and closes the response window when it lapses.
 *
 * It does **not** decide anything discretionary. A limitation expiry, for
 * instance, is flagged rather than applied: whether a case is genuinely time
 * barred can depend on facts the platform does not hold, such as a suspension
 * agreed with the taxpayer, and a scheduler that time-barred cases on its own
 * would destroy the authority's ability to collect on the basis of an
 * incomplete record.
 */
@Injectable()
export class DeadlineScheduler implements OnModuleInit {
  private readonly logger = new Logger(DeadlineScheduler.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    private readonly notifications: NotificationService,
    private readonly jobs: JobRegistryService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Registered on boot so operations can see the job exists before it has
    // ever run. A job that has never appeared is indistinguishable from one
    // that is silently broken.
    await this.jobs.register('DEADLINE_SWEEP', 'ta.job.deadlineSweep', 'hourly');
  }

  /**
   * Hourly rather than by the minute.
   *
   * A statutory deadline is a date, not a moment. Sweeping every minute would
   * be 60 times the load to move an event by less time than the granularity of
   * the thing being measured.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<void> {
    // Under the cross-replica lock. Without it, three replicas would each warn
    // the same taxpayer about the same deadline, and a taxpayer warned three
    // times stops reading the warnings. `runExclusively` also records the
    // outcome, so a failing sweep is visible in the job registry rather than
    // only in a log.
    await this.jobs.runExclusively('DEADLINE_SWEEP', async () => {
      const warned = await this.warnUpcoming();
      const breached = await this.markBreached();
      const lapsed = await this.closeLapsedResponseWindows();
      const slaBreached = await this.markSlaBreaches();

      if (warned + breached + lapsed + slaBreached === 0) return undefined;
      return (
        `${warned} warned, ${breached} breached, ${lapsed} windows lapsed, ` +
        `${slaBreached} SLA breaches`
      );
    });
  }

  /**
   * Warn once, three days out.
   *
   * `warned_at IS NULL` is what makes it once: without it every sweep in the
   * final three days would send another email, and a taxpayer who is warned
   * seventy-two times stops reading the warnings.
   */
  private async warnUpcoming(): Promise<number> {
    const rows = await this.sequelize.query<{
      id: string;
      case_id: string;
      deadline_type: string;
      due_at: string;
      case_number: string;
    }>(
      `UPDATE tax.tax_assessment_deadline d
          SET warned_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         FROM tax.tax_assessment_case c
        WHERE c.id = d.case_id
          AND d.status = 'OPEN'
          AND d.is_active
          AND d.warned_at IS NULL
          AND d.due_at <= CURRENT_DATE + INTERVAL '3 days'
          AND d.due_at > CURRENT_DATE
        RETURNING d.id::text AS id, d.case_id::text AS case_id, d.deadline_type,
                  d.due_at::text AS due_at, c.case_number`,
      { type: QueryTypes.SELECT },
    );

    for (const row of rows) {
      await this.notify('DEADLINE_APPROACHING', row.case_id, {
        caseNumber: row.case_number,
        deadlineType: row.deadline_type,
        dueDate: row.due_at,
      });
    }
    return rows.length;
  }

  /** Mark anything past its date. The row is the evidence that it lapsed. */
  private async markBreached(): Promise<number> {
    const rows = await this.sequelize.query<{
      case_id: string;
      deadline_type: string;
      due_at: string;
      case_number: string;
    }>(
      `UPDATE tax.tax_assessment_deadline d
          SET status = 'BREACHED', breached_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         FROM tax.tax_assessment_case c
        WHERE c.id = d.case_id
          AND d.status = 'OPEN'
          AND d.is_active
          AND d.due_at < CURRENT_DATE
        RETURNING d.case_id::text AS case_id, d.deadline_type,
                  d.due_at::text AS due_at, c.case_number`,
      { type: QueryTypes.SELECT },
    );

    for (const row of rows) {
      // Flagged, never applied. Whether a case is genuinely time barred can
      // turn on facts the platform does not hold.
      if (row.deadline_type === 'LIMITATION') {
        this.logger.warn(
          `Case ${row.case_number} passed its limitation date ${row.due_at}. Flagged for review; ` +
            'the platform does not time-bar a case on its own.',
        );
      }
      await this.notify('DEADLINE_BREACHED', row.case_id, {
        caseNumber: row.case_number,
        deadlineType: row.deadline_type,
        dueDate: row.due_at,
      });
    }
    return rows.length;
  }

  /**
   * Close the response window when the objection period has run.
   *
   * This is the one state change the sweeper makes, and it is safe because the
   * transition table only permits it from AWAITING_TAXPAYER_RESPONSE and
   * because an objection filed in time has already moved the case to
   * UNDER_OBJECTION, where this query cannot see it.
   */
  private async closeLapsedResponseWindows(): Promise<number> {
    const rows = await this.sequelize.query<{ case_id: string; case_number: string }>(
      `SELECT DISTINCT d.case_id::text AS case_id, c.case_number
         FROM tax.tax_assessment_deadline d
         JOIN tax.tax_assessment_case c ON c.id = d.case_id
        WHERE d.deadline_type = 'OBJECTION'
          AND d.is_active
          AND d.due_at < CURRENT_DATE
          AND c.status_code = :awaiting
          AND c.is_active`,
      {
        type: QueryTypes.SELECT,
        replacements: { awaiting: CaseStatus.AWAITING_TAXPAYER_RESPONSE },
      },
    );

    let closed = 0;
    for (const row of rows) {
      try {
        await this.cases.transition(Number(row.case_id), 'WINDOW_LAPSED', this.systemContext(), {
          reason: 'The objection window closed without an objection being filed.',
        });
        closed += 1;
      } catch (error) {
        // One stuck case must not stop the sweep for every other case.
        this.logger.warn(
          `Could not close the response window on ${row.case_number}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    return closed;
  }

  /** Internal service standards. Reported, never enforced against a taxpayer. */
  private async markSlaBreaches(): Promise<number> {
    const rows = await this.sequelize.query<{ id: string }>(
      `UPDATE tax.tax_sla_tracker
          SET status = 'BREACHED', breached_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE status = 'RUNNING'
          AND is_active
          AND target_at < CURRENT_TIMESTAMP
        RETURNING id::text AS id`,
      { type: QueryTypes.SELECT },
    );
    return rows.length;
  }

  /**
   * The identity the scheduler acts under.
   *
   * No `userId`: nothing here is attributable to a person, and inventing one
   * would put a real officer's name against an action they did not take.
   */
  private systemContext(): RequestContext {
    return {
      roleCodes: [RoleCode.SYSTEM],
      correlationId: randomUUID(),
      jurisdictionCode: 'SYSTEM',
      requestedAt: new Date(),
    };
  }

  private async notify(
    typeCode: string,
    caseId: string,
    variables: Record<string, string>,
  ): Promise<void> {
    const rows = await this.sequelize.query<{ email: string | null }>(
      `SELECT tc.email
         FROM tax.tax_assessment_case c
         JOIN platform.taxpayer t ON t.id = c.taxpayer_id
         LEFT JOIN platform.taxpayer_contact tc ON tc.taxpayer_id = t.id AND tc.is_active
        WHERE c.id = :caseId
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { caseId } },
    );

    const recipient = rows[0]?.email;
    if (recipient === null || recipient === undefined || recipient === '') return;

    try {
      await this.notifications.send({
        typeCode,
        recipient,
        variables,
        contextType: 'ASSESSMENT_CASE',
        contextId: Number(caseId),
      });
    } catch (error) {
      // The deadline state is the record that matters; a failed email must not
      // roll it back or stop the rest of the sweep.
      this.logger.warn(
        `Deadline notification ${typeCode} for case ${caseId} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
