import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { CaseService } from '../case/case.service';
import { DeadlineService } from '../deadline/deadline.service';
import { ApprovalService } from './approval.service';

@ApiTags('assessment')
@Controller()
export class ApprovalController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly deadlines: DeadlineService,
    private readonly cases: CaseService,
  ) {}

  @Post('cases/:id/route-approval')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Route a reviewed case to the approver its amount requires',
    description:
      'The band comes from the configured delegation limits, not from the caller. Asking for ' +
      'routing is permissioned; choosing the approver is not something anybody can do.',
  })
  async route(@Param('id') id: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.approvals.route(Number(id), caller!);
  }

  @Post('cases/:id/finalise')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Finalise an approved assessment',
    description:
      'Consumes the losses the calculation relied on and makes the figures the legal ' +
      'determination. After this the calculation endpoint refuses to recompute them.',
  })
  async finalise(@Param('id') id: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.approvals.finalise(Number(id), caller!);
  }

  @Get('cases/:id/deadlines')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Statutory dates for a case, with how each was derived' })
  async caseDeadlines(@Param('id') id: string) {
    const assessmentCase = await this.cases.findById(Number(id));
    return this.deadlines.allFor(assessmentCase);
  }

  @Get('approval-thresholds')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The approval delegation limits in force' })
  async thresholds(@Query('jurisdiction') jurisdiction?: string) {
    return this.approvals.thresholds(jurisdiction);
  }
}
