import { Inject, Injectable, Logger } from '@nestjs/common';
import { QueryTypes, type Sequelize } from 'sequelize';
import { APP_CONFIG, SEQUELIZE } from '../../infrastructure/tokens';
import type { AppConfig } from '../../config/configuration';

export interface JobRun {
  readonly jobCode: string;
  readonly status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  readonly detail?: string;
}

/**
 * Scheduled job bookkeeping.
 *
 * Plan reference: V2 sections 6.6, 27.4.
 *
 * ## Why a registry rather than bare cron decorators
 *
 * Three things operations need that a decorator alone cannot give:
 *
 *   - **Visibility.** "Did the deadline scheduler run last night?" must be
 *     answerable from the database. A job that silently stopped running is
 *     how a statutory deadline gets missed.
 *   - **Control.** A job can be disabled without a deploy.
 *   - **Mutual exclusion.** With more than one API replica, every replica
 *     fires the same cron. A deadline pass that runs three times could send a
 *     taxpayer three reminders.
 *
 * The lock is a conditional UPDATE on the job row: exactly one replica wins,
 * because PostgreSQL serialises the write.
 */
@Injectable()
export class JobRegistryService {
  private readonly logger = new Logger(JobRegistryService.name);

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Run `work` if this replica wins the lock and the job is enabled.
   *
   * @param staleAfterMinutes how long before a claim is assumed abandoned. A
   *        replica that crashes mid-run would otherwise block the job forever.
   */
  async runExclusively(
    jobCode: string,
    work: () => Promise<string | void>,
    staleAfterMinutes = 30,
  ): Promise<JobRun> {
    // Gated in one place rather than at each @Cron, so a job added later is
    // covered without anybody remembering to add the check.
    if (!this.config.schedulerEnabled) {
      return { jobCode, status: 'SKIPPED', detail: 'Scheduling disabled on this process' };
    }

    const claimed = await this.claim(jobCode, staleAfterMinutes);
    if (!claimed) {
      return { jobCode, status: 'SKIPPED', detail: 'Not claimed by this instance' };
    }

    try {
      const detail = await work();
      await this.complete(jobCode, 'SUCCESS', detail ?? null);
      return { jobCode, status: 'SUCCESS', detail: detail ?? undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await this.complete(jobCode, 'FAILED', message);
      this.logger.error(`Job ${jobCode} failed: ${message}`);
      return { jobCode, status: 'FAILED', detail: message };
    }
  }

  /**
   * Attempt to claim the job.
   *
   * The WHERE clause is the lock. Only a row whose last run is older than the
   * stale window, or already finished, can be claimed — so a concurrent
   * replica's UPDATE matches zero rows and it stands down.
   */
  private async claim(jobCode: string, staleAfterMinutes: number): Promise<boolean> {
    const [, affected] = await this.sequelize.query(
      `UPDATE platform.scheduled_job
          SET last_run_at = CURRENT_TIMESTAMP,
              last_status = 'RUNNING',
              updated_at  = CURRENT_TIMESTAMP
        WHERE job_code = :jobCode
          AND enabled
          AND is_active
          AND (
                last_status IS DISTINCT FROM 'RUNNING'
                OR last_run_at < CURRENT_TIMESTAMP - (:staleAfter || ' minutes')::interval
              )`,
      {
        type: QueryTypes.UPDATE,
        replacements: { jobCode, staleAfter: String(staleAfterMinutes) },
      },
    );
    return (affected ?? 0) > 0;
  }

  private async complete(jobCode: string, status: string, detail: string | null): Promise<void> {
    await this.sequelize.query(
      `UPDATE platform.scheduled_job
          SET last_status = :status,
              last_error  = :detail,
              updated_at  = CURRENT_TIMESTAMP
        WHERE job_code = :jobCode`,
      { type: QueryTypes.UPDATE, replacements: { jobCode, status, detail } },
    );
  }

  /** Register a job, idempotently. Called on boot by each scheduler. */
  async register(jobCode: string, displayKey: string, cronExpression: string): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO platform.scheduled_job (job_code, display_key, cron_expression)
            VALUES (:jobCode, :displayKey, :cronExpression)
       ON CONFLICT (job_code) DO UPDATE
               SET display_key = EXCLUDED.display_key,
                   cron_expression = EXCLUDED.cron_expression,
                   updated_at = CURRENT_TIMESTAMP`,
      {
        type: QueryTypes.INSERT,
        replacements: { jobCode, displayKey, cronExpression },
      },
    );
  }

  /** Current state of every job. The operational runbook view (plan 27.4). */
  async status(): Promise<
    Array<{
      jobCode: string;
      cronExpression: string;
      enabled: boolean;
      lastRunAt: Date | null;
      lastStatus: string | null;
      lastError: string | null;
    }>
  > {
    const rows = await this.sequelize.query<{
      job_code: string;
      cron_expression: string;
      enabled: boolean;
      last_run_at: Date | null;
      last_status: string | null;
      last_error: string | null;
    }>(
      `SELECT job_code, cron_expression, enabled, last_run_at, last_status, last_error
         FROM platform.scheduled_job
        WHERE is_active
        ORDER BY job_code`,
      { type: QueryTypes.SELECT },
    );

    return rows.map((row) => ({
      jobCode: row.job_code,
      cronExpression: row.cron_expression,
      enabled: row.enabled,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
    }));
  }
}
