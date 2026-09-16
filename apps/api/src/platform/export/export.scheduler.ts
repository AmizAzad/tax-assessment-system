import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobRegistryService } from '../scheduling/job-registry.service';
import { ExportService } from './export.service';

/**
 * Produce the exports that were too large to build in a request.
 *
 * Plan reference: V2 sections 6.6, 6.8.
 *
 * ## Why a poll and not a queue
 *
 * The job table is already the audit record of who exported what, so it is
 * the queue as well; a second queue would need reconciling with it. The
 * claim uses `FOR UPDATE SKIP LOCKED`, which gives the property that matters
 * — two replicas never build the same file — without another piece of
 * infrastructure to run.
 *
 * ## Why every minute
 *
 * An export is something an officer asks for and comes back to. A minute is
 * fast enough that the file is usually there when they look, and slow enough
 * that an idle system is not running a query every few seconds for nothing.
 */
@Injectable()
export class ExportScheduler implements OnModuleInit {
  private readonly logger = new Logger(ExportScheduler.name);

  constructor(
    private readonly jobs: JobRegistryService,
    private readonly exports: ExportService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.register('EXPORT_PRODUCE', 'ta.job.exportProduce', 'every minute');
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async produceQueued(): Promise<void> {
    await this.jobs.runExclusively('EXPORT_PRODUCE', async () => {
      const produced = await this.exports.runQueued();
      if (produced > 0) {
        this.logger.log(`Produced ${produced} queued export(s)`);
      }
      return produced === 0 ? undefined : `${produced} produced`;
    });
  }
}
