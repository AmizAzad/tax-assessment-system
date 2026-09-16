import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../auth/decorators';
import { PermissionLevel } from '../authorization/permission.model';
import { JobRegistryService } from './job-registry.service';

/**
 * Scheduled job visibility.
 *
 * Plan reference: V2 section 27.4 (operational runbook).
 *
 * "Did the deadline scheduler run last night?" must be answerable without
 * database access. A job that silently stopped running is how a statutory
 * deadline gets missed.
 */
@ApiTags('admin')
@Controller('admin/jobs')
export class SchedulingController {
  constructor(private readonly jobs: JobRegistryService) {}

  @Get()
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Scheduled jobs and their last run' })
  async status() {
    return this.jobs.status();
  }
}
