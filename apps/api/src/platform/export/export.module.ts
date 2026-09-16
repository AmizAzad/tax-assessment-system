import { Module } from '@nestjs/common';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { ExportController } from './export.controller';
import { ExportScheduler } from './export.scheduler';
import { ExportService } from './export.service';

/**
 * Register exports.
 *
 * The scheduler is registered here rather than in the worker app so that a
 * single-process deployment still drains the queue. `runExclusively` makes
 * that safe with several replicas: one claims the job, the rest skip.
 */
@Module({
  imports: [SchedulingModule],
  controllers: [ExportController],
  providers: [ExportService, ExportScheduler],
  exports: [ExportService],
})
export class ExportModule {}
