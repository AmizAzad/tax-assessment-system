import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobRegistryService } from '../platform/scheduling/job-registry.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Scheduled workflow maintenance.
 *
 * Plan reference: V2 sections 5.5, 27.4; ADR-002.
 *
 * Reconciliation is the mitigation ADR-002 promised for accepting eventual
 * consistency. Every ten minutes is a compromise: often enough that a task
 * invisible to an officer is recovered the same working hour, rare enough that
 * the engine is not queried constantly for instances that have not changed.
 */
@Injectable()
export class WorkflowScheduler implements OnModuleInit {
  constructor(
    private readonly jobs: JobRegistryService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.jobs.register(
      'WORKFLOW_RECONCILIATION',
      'ta.job.workflowReconciliation',
      'every 10 minutes',
    );
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcile(): Promise<void> {
    await this.jobs.runExclusively('WORKFLOW_RECONCILIATION', async () => {
      const report = await this.reconciliation.reconcile();
      if (!report.engineReachable) {
        return 'engine unreachable; skipped';
      }
      // A healthy system reconciles to nothing, so only report when it did not.
      return report.divergences.length === 0
        ? undefined
        : `repaired ${report.divergences.length} divergence(s) across ` +
            `${report.checkedInstances} instance(s)`;
    });
  }
}
