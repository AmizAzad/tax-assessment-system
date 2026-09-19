import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CaseStatus, RoleCode, statusesWithAction } from '@tas/contracts';
import { QueryTypes, Sequelize } from 'sequelize';
import { randomUUID } from 'node:crypto';
import { APP_CONFIG, SEQUELIZE } from '../../infrastructure/tokens';
import type { AppConfig } from '../../config/configuration';
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
 * - closes the response window when it lapses,
 * - and time-bars a case whose limitation period has run.
 *
 * Time-barring is the one effect here that destroys something. Whether a case
 * is genuinely time barred can turn on facts the platform does not hold, such
 * as a limitation period suspended by agreement with the taxpayer or restarted
 * by an event recorded in another office, and `TIME_BARRED` is terminal, so a
 * case closed on an incomplete record is a debt the authority can no longer
 * collect. Those missing facts are now the reason for the bounds rather than a
 * reason to refuse outright. The sweep time-bars nothing unless
 * `TIME_BAR_ON_LIMITATION_EXPIRY` is on, it never touches a case under
 * `legal_hold`, which is the flag an officer sets when the record is known to
 * be incomplete, and it moves a case only from the statuses the transition
 * table declares for `LIMITATION_EXPIRED`. ADR-017 records the reversal of the
 * earlier refusal and what the user was told it costs.
 */
@Injectable()
export class DeadlineScheduler implements OnModuleInit {
  private readonly logger = new Logger(DeadlineScheduler.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    private readonly cases: CaseService,
    private readonly notifications: NotificationService,
    private readonly jobs: JobRegistryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
      const timeBarred = await this.applyLimitationExpiry();
      const lapsed = await this.closeLapsedResponseWindows();
      const slaBreached = await this.markSlaBreaches();

      if (warned + breached + timeBarred + lapsed + slaBreached === 0) return undefined;
      return (
        `${warned} warned, ${breached} breached, ${timeBarred} time-barred, ` +
        `${lapsed} windows lapsed, ${slaBreached} SLA breaches`
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
      // A time-barred case is the one an officer is later asked to explain,
      // and this line is where that explanation starts.
      if (row.deadline_type === 'LIMITATION') {
        this.logger.warn(
          `Case ${row.case_number} passed its limitation date ${row.due_at}. ` +
            (this.config.timeBarOnLimitationExpiry
              ? 'This sweep time-bars it unless a bound in ADR-017 holds it back.'
              : 'Flagged for review; the platform does not time-bar a case on its own.'),
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
   * Apply an expired limitation period (ADR-017).
   *
   * Runs after `markBreached`, which is the pass that puts a lapsed limitation
   * row into the BREACHED state this query selects on.
   *
   * Nothing marks a case as already handled, and nothing needs to. The
   * operation converges by construction. A case this method time-bars sits at
   * TIME_BARRED, which `statusesWithAction('LIMITATION_EXPIRED')` does not
   * contain, so it drops out of the candidate set on the next pass, and
   * `assertTransition` refuses every action out of a terminal status anyway.
   */
  private async applyLimitationExpiry(): Promise<number> {
    if (!this.config.timeBarOnLimitationExpiry) return 0;

    const rows = await this.sequelize.query<{
      case_id: string;
      case_number: string;
      status_code: string;
      due_at: string;
    }>(
      `SELECT DISTINCT d.case_id::text AS case_id, c.case_number, c.status_code,
              d.due_at::text AS due_at
         FROM tax.tax_assessment_deadline d
         JOIN tax.tax_assessment_case c ON c.id = d.case_id
        WHERE d.deadline_type = 'LIMITATION'
          AND d.status = 'BREACHED'
          AND d.is_active
          AND d.due_at < CURRENT_DATE
          AND c.is_active
          AND NOT c.legal_hold
          AND c.status_code IN (:statuses)`,
      {
        type: QueryTypes.SELECT,
        // Read off the transition table rather than restated here, so the
        // table stays the single statement of where this is legal.
        replacements: { statuses: [...statusesWithAction('LIMITATION_EXPIRED')] },
      },
    );

    let barred = 0;
    for (const row of rows) {
      try {
        await this.cases.transition(
          Number(row.case_id),
          'LIMITATION_EXPIRED',
          this.systemContext(),
          {
            reason: `The limitation date ${row.due_at} passed with the case still ${row.status_code}.`,
            // The ledger has to carry that the platform applied this, because
            // no officer can be asked to account for it later.
            appliedBy: 'PLATFORM',
            appliedByJob: 'DEADLINE_SWEEP',
            limitationDate: row.due_at,
          },
        );
        barred += 1;
      } catch (error) {
        // One stuck case must not stop the sweep for every other case.
        this.logger.warn(
          `Could not time-bar ${row.case_number}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
    return barred;
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
    try {
      // A contact is a channel and a value, never a column per channel, so
      // `tc.email` never existed and this query raised rather than returned a
      // recipient. The address of record is preferred, because that is the
      // address statutory service runs against.
      const rows = await this.sequelize.query<{ email: string | null }>(
        `SELECT tc.value AS email
           FROM tax.tax_assessment_case c
           JOIN platform.taxpayer t ON t.id = c.taxpayer_id
           LEFT JOIN platform.taxpayer_contact tc
                  ON tc.taxpayer_id = t.id AND tc.is_active AND tc.channel = 'EMAIL'
          WHERE c.id = :caseId
          ORDER BY tc.is_service_address DESC
          LIMIT 1`,
        { type: QueryTypes.SELECT, replacements: { caseId } },
      );

      const recipient = rows[0]?.email;
      if (recipient === null || recipient === undefined || recipient === '') return;

      await this.notifications.send({
        typeCode,
        recipient,
        variables,
        contextType: 'ASSESSMENT_CASE',
        contextId: Number(caseId),
      });
    } catch (error) {
      // The deadline state is the record that matters; a failed email must not
      // roll it back or stop the rest of the sweep. The guard covers the
      // recipient lookup too, because that is what actually failed: the wrong
      // column name raised out of `markBreached` and took the limitation,
      // response-window and SLA passes down with it, none of which notify
      // anybody.
      this.logger.warn(
        `Deadline notification ${typeCode} for case ${caseId} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
