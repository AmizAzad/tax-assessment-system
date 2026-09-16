import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { GridService } from '../../platform/grid/grid.service';
import { AdjustmentService } from './adjustment.service';
import { AdjustmentDto, AssignDto, CreateCaseDto, TransitionDto } from './case.dto';
import { CaseService } from './case.service';
import { RegisterGridSource } from './register.source';

@ApiTags('assessment')
@Controller('cases')
export class CaseController {
  constructor(
    private readonly cases: CaseService,
    private readonly adjustments: AdjustmentService,
    private readonly register: RegisterGridSource,
    private readonly grids: GridService,
  ) {}

  @Post()
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Open an assessment case' })
  async create(@Body() body: CreateCaseDto, @CurrentUser() caller: RequestContext | undefined) {
    return this.cases.create(body, caller!);
  }

  /**
   * The assessment register.
   *
   * The standard list contract from plan section 6.8: `page`, `pageSize`,
   * `sort` and filters, with the columns themselves configured rather than
   * fixed here. The rows come from the same grid source the export uses, so
   * a spreadsheet and the screen cannot disagree about what the register
   * contains.
   *
   * `sort` is `key:asc` or `key:desc` and is checked against the source's
   * allowlist before it reaches SQL.
   */
  @Get()
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The assessment register, scoped to the caller' })
  async search(
    @CurrentUser() caller: RequestContext | undefined,
    @Query('status') status?: string,
    @Query('taxTypeCode') taxTypeCode?: string,
    @Query('jurisdiction') jurisdiction?: string,
    @Query('assessmentYear') assessmentYear?: string,
    @Query('search') search?: string,
    @Query('openedFrom') openedFrom?: string,
    @Query('openedTo') openedTo?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    // Clamped, not validated into an error. A page size of a million is a
    // client bug or an extraction attempt; either way the right answer is a
    // sensible page, and the export route is the supported way to take the
    // register away.
    const size = Math.min(Math.max(Number(pageSize ?? 25) || 25, 1), 200);
    const requestedPage = Math.max(Number(page ?? 1) || 1, 1);

    return this.register.page(
      { userId: caller!.userId ?? -1, roleCodes: caller!.roleCodes },
      {
        filters: {
          status,
          taxTypeCode,
          jurisdiction,
          assessmentYear,
          search,
          openedFrom,
          openedTo,
        },
        sort: this.grids.resolveSort(this.register, sort),
        limit: size,
        offset: (requestedPage - 1) * size,
      },
    );
  }

  @Get(':id')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'One case' })
  async findOne(@Param('id') id: string) {
    return this.cases.findById(Number(id));
  }

  @Get(':id/timeline')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The domain audit ledger for a case' })
  async timeline(@Param('id') id: string) {
    return this.cases.timeline(Number(id));
  }

  /**
   * Move a case to its next status.
   *
   * One endpoint rather than one per action: the state machine decides what is
   * permitted, so a per-action endpoint would duplicate that table in the
   * routing layer and let the two drift.
   */
  @Post(':id/transition')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Apply a lifecycle action (START, SUBMIT, ACCEPT, APPROVE, ...)' })
  async transition(
    @Param('id') id: string,
    @Body() body: TransitionDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    // The convenience fields travel on the audit payload rather than as
    // separate arguments, because the state machine decides what an action
    // means and the ledger records whatever context came with it.
    const payload: Record<string, unknown> = { ...(body.payload ?? {}) };
    if (body.assigneeUsername !== undefined) payload['assigneeUsername'] = body.assigneeUsername;
    if (body.reason !== undefined) payload['reason'] = body.reason;

    return this.cases.transition(Number(id), body.action, caller!, payload);
  }

  @Post(':id/assign')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Assign the case to a user in a role' })
  async assign(
    @Param('id') id: string,
    @Body() body: AssignDto,
    @CurrentUser() caller: RequestContext | undefined,
  ): Promise<{ assigned: boolean }> {
    await this.cases.assign(Number(id), body.userId, body.roleCode, caller!);
    return { assigned: true };
  }

  @Get(':id/adjustments')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Adjustments on a case' })
  async listAdjustments(@Param('id') id: string) {
    return this.adjustments.listFor(Number(id));
  }

  @Post(':id/adjustments')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Record an adjustment' })
  async addAdjustment(
    @Param('id') id: string,
    @Body() body: AdjustmentDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.adjustments.add(Number(id), body, caller!);
  }
}
