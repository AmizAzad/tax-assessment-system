import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { ClosureService } from './closure.service';
import { ReassessmentService } from './reassessment.service';

export class ReassessDto {
  @IsString()
  @MinLength(10, {
    message:
      'A reassessment must state its grounds. Reopening a determination without a recorded ' +
      'reason is the thing this record exists to prevent.',
  })
  @MaxLength(8000)
  grounds!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  triggerSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  limitationOverrideReason?: string;
}

export class CloseDto {
  @IsString()
  @MaxLength(40)
  reasonCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  narrative?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  retentionClass?: string;
}

export class LegalHoldDto {
  @IsBoolean()
  hold!: boolean;

  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  reason!: string;
}

@ApiTags('lifecycle')
@Controller()
export class LifecycleController {
  constructor(
    private readonly reassessments: ReassessmentService,
    private readonly closures: ClosureService,
  ) {}

  @Post('cases/:id/reassess')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Open a reassessment',
    description:
      'The case status decides the shape: a dispute outcome reassesses in place, while a ' +
      'closed case is succeeded by a new one. Reaching past the limitation date requires an ' +
      'explicit override reason and is attributed to the person who authorised it.',
  })
  async reassess(
    @Param('id') id: string,
    @Body() body: ReassessDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.reassessments.reassess(Number(id), body, caller!);
  }

  @Get('cases/:id/reassessments')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Reassessments opened on a case' })
  async history(@Param('id') id: string) {
    return this.reassessments.historyFor(Number(id));
  }

  @Get('cases/:id/lineage')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Every assessment of this period, predecessors and successors',
    description: 'Walks the chain in both directions, however many times the period was assessed.',
  })
  async lineage(@Param('id') id: string) {
    return this.reassessments.lineage(Number(id));
  }

  @Get('cases/:id/calculation/delta')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'What changed between the two most recent calculation versions',
    description: 'The question a reviewer asks about any reassessment, line by line.',
  })
  async delta(@Param('id') id: string) {
    return this.reassessments.delta(Number(id));
  }

  @Post('cases/:id/close')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Close a case',
    description:
      'Snapshots the final position and sets the retention date. The balance is frozen into ' +
      'the record rather than recomputed later, because the file must say what it said at the ' +
      'time.',
  })
  async close(
    @Param('id') id: string,
    @Body() body: CloseDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.closures.close(Number(id), body, caller!);
  }

  @Get('cases/:id/closure')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The closure record, including retention and any legal hold' })
  async closure(@Param('id') id: string) {
    return this.closures.closureFor(Number(id));
  }

  @Post('cases/:id/legal-hold')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Place or lift a legal hold',
    description:
      'A hold outranks the retention date, so a file under litigation survives its own ' +
      'destruction schedule. Both placing and lifting require a reason.',
  })
  async legalHold(
    @Param('id') id: string,
    @Body() body: LegalHoldDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.closures.setLegalHold(Number(id), body, caller!);
  }
}
