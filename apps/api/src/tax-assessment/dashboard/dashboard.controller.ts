import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Headline position, scoped to the caller',
    description:
      'An assessor sees their own cases, a supervisor sees the team’s. Assessed and collected ' +
      'are reported separately and never added together.',
  })
  async summary(@CurrentUser() caller: RequestContext | undefined) {
    return this.dashboard.summary(caller!);
  }

  @Get('workload')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Open cases by status, and by how long they have been open' })
  async workload(@CurrentUser() caller: RequestContext | undefined) {
    return this.dashboard.workload(caller!);
  }

  @Get('throughput')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Assessments finalised per month',
    description: 'Months with no work finalised are returned as zero rather than omitted.',
  })
  async throughput(
    @CurrentUser() caller: RequestContext | undefined,
    @Query('months') months?: string,
  ) {
    const requested = Number(months ?? 12);
    // Clamped rather than validated into an error: a nonsense value on a
    // dashboard should draw a sensible chart, not a red box.
    const clamped = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 36) : 12;
    return this.dashboard.throughput(caller!, clamped);
  }

  @Get('sla')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Service levels and statutory deadlines',
    description:
      'Reported separately. An internal service level is a promise the authority made to ' +
      'itself; a statutory deadline is one the law made for it, and missing the second can ' +
      'make an assessment unenforceable.',
  })
  async sla(@CurrentUser() caller: RequestContext | undefined) {
    return this.dashboard.sla(caller!);
  }
}
