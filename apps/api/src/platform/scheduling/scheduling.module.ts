import { Global, Module } from '@nestjs/common';
import { JobRegistryService } from './job-registry.service';
import { SchedulingController } from './scheduling.controller';
import { PlatformScheduler } from './platform.scheduler';

/** Scheduled work, with a registry so operations can see and control it. */
@Global()
@Module({
  controllers: [SchedulingController],
  providers: [JobRegistryService, PlatformScheduler],
  exports: [JobRegistryService],
})
export class SchedulingModule {}
