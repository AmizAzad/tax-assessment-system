import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { AppealService } from './appeal.service';
import { DepositService } from './deposit.service';
import { ObjectionService } from './objection.service';

/** Amounts are decimal strings, never JSON numbers (ADR-007). */
const AMOUNT = /^-?\d{1,16}(\.\d{1,4})?$/;
const AMOUNT_MESSAGE =
  'must be a decimal string such as "1234.56". Numbers are refused because JSON numbers ' +
  'cannot represent money exactly (ADR-007).';

export class ObjectionGroundDto {
  @IsString()
  @MaxLength(40)
  groundCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;

  @IsOptional()
  @Matches(AMOUNT, { message: `disputedAmount ${AMOUNT_MESSAGE}` })
  disputedAmount?: string;

  @IsOptional()
  @IsInt()
  adjustmentId?: number;
}

export class FileObjectionDto {
  @IsString()
  @MinLength(10, {
    message:
      'An objection must explain what is disputed. Ten characters is not a summary of grounds.',
  })
  @MaxLength(8000)
  groundsSummary!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'An objection must state at least one ground.' })
  @ValidateNested({ each: true })
  @Type(() => ObjectionGroundDto)
  grounds!: ObjectionGroundDto[];

  @IsOptional()
  @Matches(AMOUNT, { message: `requestedRelief ${AMOUNT_MESSAGE}` })
  requestedRelief?: string;

  @IsOptional()
  @IsIn(['PORTAL', 'EMAIL', 'POST', 'IN_PERSON'])
  filedChannel?: string;

  @IsOptional()
  @IsISO8601()
  filedOn?: string;
}

export class AdmissibilityDto {
  @IsIn(['ADMITTED', 'INADMISSIBLE'])
  admissibility!: 'ADMITTED' | 'INADMISSIBLE';

  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  reason!: string;
}

export class OpinionDto {
  @IsIn(['ALLOW', 'PARTLY_ALLOW', 'REJECT', 'ABSTAIN'])
  opinion!: 'ALLOW' | 'PARTLY_ALLOW' | 'REJECT' | 'ABSTAIN';

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reasoning?: string;
}

export class GroundOutcomeDto {
  @IsInt()
  groundId!: number;

  @IsIn(['ALLOWED', 'PARTLY_ALLOWED', 'REJECTED'])
  outcome!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reason?: string;
}

export class ObjectionDecisionDto {
  @IsIn(['ALLOWED', 'PARTLY_ALLOWED', 'REJECTED'])
  decision!: 'ALLOWED' | 'PARTLY_ALLOWED' | 'REJECTED';

  @IsString()
  @MinLength(10, {
    message:
      'An objection decision must give reasons. A decision without them cannot be appealed ' +
      'against intelligibly.',
  })
  @MaxLength(8000)
  reason!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => GroundOutcomeDto)
  groundOutcomes?: GroundOutcomeDto[];
}

export class WithdrawDto {
  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  reason!: string;
}

export class FileAppealDto {
  @IsString()
  @MaxLength(40)
  forumCode!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(8000)
  groundsSummary!: string;

  @IsOptional()
  @Matches(AMOUNT, { message: `disputedAmount ${AMOUNT_MESSAGE}` })
  disputedAmount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalReference?: string;

  @IsOptional()
  @IsIn(['TAXPAYER', 'AUTHORITY'])
  filedBy?: 'TAXPAYER' | 'AUTHORITY';

  @IsOptional()
  @IsISO8601()
  filedOn?: string;

  @IsOptional()
  @IsBoolean()
  collectionStayed?: boolean;
}

export class HearingDto {
  @IsISO8601()
  scheduledFor!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  venue?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  representative?: string;
}

export class AppealOutcomeDto {
  @IsIn(['UPHELD', 'VARIED', 'SET_ASIDE', 'REMANDED'])
  outcome!: 'UPHELD' | 'VARIED' | 'SET_ASIDE' | 'REMANDED';

  @IsString()
  @MinLength(10)
  @MaxLength(8000)
  reason!: string;

  @IsOptional()
  @IsISO8601()
  decidedOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalReference?: string;
}

export class ImplementDto {
  @IsString()
  @MinLength(5)
  @MaxLength(4000)
  note!: string;
}

export class DepositDto {
  @Matches(AMOUNT, { message: `amount ${AMOUNT_MESSAGE}` })
  amount!: string;
}

@ApiTags('disputes')
@Controller()
export class DisputeController {
  constructor(
    private readonly objections: ObjectionService,
    private readonly appeals: AppealService,
    private readonly deposits: DepositService,
  ) {}

  // ------------------------------------------------------------------ objections

  @Post('cases/:id/objections')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'File an objection against a served assessment',
    description:
      'Accepted even when out of time. Whether a late objection is heard is a discretion the ' +
      'law gives to a person, so lateness is recorded and admissibility is decided separately.',
  })
  async fileObjection(
    @Param('id') id: string,
    @Body() body: FileObjectionDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.objections.file(Number(id), body, caller!);
  }

  @Get('cases/:id/objections')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Objections on a case' })
  async listObjections(@Param('id') id: string) {
    return this.objections.listForCase(Number(id));
  }

  @Get('objections/:uuid')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'An objection with its grounds and any panel opinions' })
  async readObjection(@Param('uuid') uuid: string) {
    return this.objections.findByUuid(uuid);
  }

  @Post('objections/:uuid/admissibility')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Admit an objection, or refuse to hear it',
    description:
      'Must give a reason. Refusing to hear a person without one is not a decision they can ' +
      'challenge. Cannot be done by an officer who worked the assessment.',
  })
  async admissibility(
    @Param('uuid') uuid: string,
    @Body() body: AdmissibilityDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.objections.decideAdmissibility(uuid, body, caller!);
  }

  @Post('objections/:uuid/opinions')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Record a panel member opinion',
    description: 'One per member; giving another replaces it rather than counting twice.',
  })
  async opinion(
    @Param('uuid') uuid: string,
    @Body() body: OpinionDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.objections.recordOpinion(uuid, body, caller!);
  }

  @Post('objections/:uuid/decision')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Decide an objection',
    description:
      'The decision is the officer’s, not a tally of opinions. One that departs from the ' +
      'panel is permitted and logged, because it is the one that will be questioned.',
  })
  async decide(
    @Param('uuid') uuid: string,
    @Body() body: ObjectionDecisionDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.objections.decide(uuid, body, caller!);
  }

  @Post('objections/:uuid/withdraw')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Withdraw an objection' })
  async withdraw(
    @Param('uuid') uuid: string,
    @Body() body: WithdrawDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.objections.withdraw(uuid, body.reason, caller!);
  }

  @Get('objections/:uuid/deposit')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'What deposit this objection requires, and how it was worked out',
    description:
      'A jurisdiction with no configured rule requires nothing. Inventing one would put a ' +
      'financial barrier in front of a statutory right.',
  })
  async depositPosition(@Param('uuid') uuid: string) {
    return this.deposits.assess(uuid);
  }

  @Post('objections/:uuid/deposit')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'Record a deposit paid against an objection' })
  async recordDeposit(
    @Param('uuid') uuid: string,
    @Body() body: DepositDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.deposits.record(uuid, body.amount, caller!);
  }

  // ------------------------------------------------------------------ appeals

  @Post('cases/:id/appeals')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'File an appeal against an objection decision',
    description: 'The forum must be one the jurisdiction recognises (APPEAL_FORUM master data).',
  })
  async fileAppeal(
    @Param('id') id: string,
    @Body() body: FileAppealDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.appeals.file(Number(id), body, caller!);
  }

  @Get('cases/:id/appeals')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Appeals on a case' })
  async listAppeals(@Param('id') id: string) {
    return this.appeals.listForCase(Number(id));
  }

  @Get('appeals/:uuid')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'An appeal with its hearings' })
  async readAppeal(@Param('uuid') uuid: string) {
    return this.appeals.findByUuid(uuid);
  }

  @Post('appeals/:uuid/hearings')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({ summary: 'List a hearing' })
  async listHearing(
    @Param('uuid') uuid: string,
    @Body() body: HearingDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.appeals.listHearing(uuid, body, caller!);
  }

  @Post('appeals/:uuid/outcome')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Record what the forum held',
    description:
      'Transcription, not decision: an appeal is decided outside the authority. The reasons ' +
      'determine what the authority now has to do.',
  })
  async outcome(
    @Param('uuid') uuid: string,
    @Body() body: AppealOutcomeDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.appeals.recordOutcome(uuid, body, caller!);
  }

  @Post('appeals/:uuid/implement')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Record that the decision has been given effect',
    description:
      'Separate from recording the outcome on purpose. An appeal won and never implemented ' +
      'means the taxpayer holds a judgment the register does not reflect.',
  })
  async implement(
    @Param('uuid') uuid: string,
    @Body() body: ImplementDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.appeals.implement(uuid, body.note, caller!);
  }

  @Get('disputes')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({
    summary: 'The dispute register',
    description:
      'Objections and appeals together. `overdueImplementation=true` lists appeals decided but ' +
      'not yet given effect.',
  })
  async register(
    @Query('status') status?: string,
    @Query('overdueImplementation') overdueImplementation?: string,
  ) {
    return this.appeals.register({
      status,
      overdueImplementationOnly: overdueImplementation === 'true',
    });
  }
}
