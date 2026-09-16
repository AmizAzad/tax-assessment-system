import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../platform/auth/decorators';
import type { RequestContext } from '../platform/auth/request-context';
import { PermissionLevel } from '../platform/authorization/permission.model';
import { ReconciliationService, type ReconciliationReport } from './reconciliation.service';
import { TaskInboxService, type InboxTask } from './task-inbox.service';

@ApiTags('workflow')
@Controller('workflow')
export class WorkflowController {
  constructor(
    private readonly inbox: TaskInboxService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /**
   * The caller's task inbox.
   *
   * Roles come from the authenticated context, never from a parameter:
   * otherwise the inbox becomes an enumeration oracle for other people's work.
   */
  @Get('tasks')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Open tasks this caller may act on' })
  async myTasks(
    @CurrentUser() caller: RequestContext | undefined,
    @Query('limit') limit?: string,
  ): Promise<readonly InboxTask[]> {
    if (caller === undefined) return [];
    return this.inbox.forCaller(caller, Math.min(Number(limit ?? 100) || 100, 500));
  }

  @Post('tasks/:taskId/claim')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Claim a task' })
  async claim(
    @Param('taskId') taskId: string,
    @CurrentUser() caller: RequestContext | undefined,
  ): Promise<{ claimed: boolean }> {
    await this.inbox.claim(taskId, caller!);
    return { claimed: true };
  }

  @Post('tasks/:taskId/complete')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Complete a task with an action code' })
  async complete(
    @Param('taskId') taskId: string,
    @Body() body: { stepCode: string; actionCode: string; data?: Record<string, unknown> },
    @CurrentUser() caller: RequestContext | undefined,
  ): Promise<{ completed: boolean }> {
    await this.inbox.complete(taskId, body.stepCode, body.actionCode, body.data ?? {}, caller!);
    return { completed: true };
  }

  /**
   * Run reconciliation on demand.
   *
   * Normally scheduled. Exposed because an operator investigating a missing
   * task should be able to trigger a repair without waiting for the next run
   * (plan 27.4).
   */
  @Post('reconcile')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({ summary: 'Reconcile the read model against the engine' })
  async reconcile(): Promise<ReconciliationReport> {
    return this.reconciliation.reconcile();
  }
}
