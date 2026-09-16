import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationDispatcher } from '../notification/notification.dispatcher';
import { JobRegistryService } from './job-registry.service';

/**
 * Platform-level scheduled work.
 *
 * Plan reference: V2 sections 6.6, 27.4.
 *
 * Every job goes through `runExclusively`, so with more than one API replica
 * exactly one runs it. Without that, three replicas would send a taxpayer
 * three copies of the same reminder.
 *
 * Domain schedulers — deadline evaluation, auto-closure, selection campaigns —
 * live with their domains in later phases. Only platform concerns are here.
 */
@Injectable()
export class PlatformScheduler implements OnModuleInit {
  private readonly logger = new Logger(PlatformScheduler.name);

  constructor(
    private readonly jobs: JobRegistryService,
    private readonly notifications: NotificationDispatcher,
  ) {}

  async onModuleInit(): Promise<void> {
    // Registered on boot so operations can see a job exists before it has ever
    // run. A job that has never appeared is indistinguishable from one that is
    // silently broken.
    await this.jobs.register(
      'NOTIFICATION_DISPATCH',
      'ta.job.notificationDispatch',
      'every minute',
    );
    await this.jobs.register(
      'NOTIFICATION_RETRY_SWEEP',
      'ta.job.notificationRetrySweep',
      'every 15 minutes',
    );
  }

  /**
   * Deliver queued notifications.
   *
   * Every minute: an officer assigned a case should hear about it promptly,
   * and a taxpayer information request has a statutory response window that
   * starts when it is sent.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async dispatchNotifications(): Promise<void> {
    await this.jobs.runExclusively('NOTIFICATION_DISPATCH', async () => {
      const report = await this.notifications.dispatchPending();
      return report.attempted === 0
        ? undefined
        : `attempted ${report.attempted}, sent ${report.sent}, failed ${report.failed}`;
    });
  }

  /**
   * Report on notifications that have exhausted their retries.
   *
   * These are not retried again — a permanently bad address should surface as
   * something an officer acts on, not as an endlessly retrying queue entry.
   * This job exists so that "we never reached this taxpayer" is visible rather
   * than buried in a table nobody reads.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async reportFailedNotifications(): Promise<void> {
    await this.jobs.runExclusively('NOTIFICATION_RETRY_SWEEP', async () => {
      const report = await this.notifications.dispatchPending(100);
      if (report.failed > 0) {
        this.logger.warn(
          `${report.failed} notification(s) failed delivery in this sweep. ` +
            `Check platform.notification_history where status = 'FAILED'.`,
        );
      }
      return report.failed === 0 ? undefined : `${report.failed} failed`;
    });
  }
}
