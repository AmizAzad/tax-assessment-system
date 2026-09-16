import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { SelectionService } from './selection.service';

export class RunSelectionDto {
  @IsString()
  @MaxLength(3)
  jurisdictionCode!: string;

  @IsString()
  @MaxLength(20)
  taxTypeCode!: string;

  @IsString()
  @MaxLength(9)
  assessmentYear!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  scoreThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxCases?: number;
}

export class OpenCasesDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  maxCases!: number;
}

@ApiTags('selection')
@Controller('selection')
export class SelectionController {
  constructor(private readonly selection: SelectionService) {}

  @Post('runs')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Score taxpayers against the risk rules in force',
    description:
      'Produces candidates and scores. It opens nothing: committing the authority to assessing ' +
      'people is a separate act, so a supervisor can see which rules fired first.',
  })
  async run(@Body() body: RunSelectionDto, @CurrentUser() caller: RequestContext | undefined) {
    return this.selection.run(body, caller!);
  }

  @Get('runs')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Selection runs' })
  async runs() {
    return this.selection.listRuns();
  }

  @Get('runs/:id')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Candidates from a run, with the rules that fired on each',
    description: 'Kept so a selection can be explained when somebody asks why they were picked.',
  })
  async candidates(@Param('id') id: string) {
    return this.selection.candidatesFor(Number(id));
  }

  @Post('runs/:id/open-cases')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Open cases for the selected candidates',
    description:
      'Honours the cap strictly. A run that selected more than an office can work should open ' +
      'what it can and say so, not flood the register.',
  })
  async openCases(
    @Param('id') id: string,
    @Body() body: OpenCasesDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.selection.openCases(Number(id), body.maxCases, caller!);
  }
}

@ApiTags('selection')
@Controller('risk-rules')
export class RiskRuleController {
  constructor(private readonly selection: SelectionService) {}

  @Get()
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'Risk rules in force',
    description:
      'Each names an indicator the platform implements. Thresholds and weights are ' +
      'configuration; the meaning of an indicator is deliberately not.',
  })
  async rules(@Query('jurisdiction') jurisdiction?: string) {
    return this.selection.rules(jurisdiction);
  }
}
