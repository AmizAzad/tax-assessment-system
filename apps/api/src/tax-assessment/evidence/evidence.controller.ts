import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { CurrentUser, RequirePermission } from '../../platform/auth/decorators';
import type { RequestContext } from '../../platform/auth/request-context';
import { PermissionLevel } from '../../platform/authorization/permission.model';
import { AccountService } from './account.service';
import { EvidenceService } from './evidence.service';

/**
 * Amount as a decimal string.
 *
 * Deliberately a string with a regex rather than `@IsNumber()`. A JSON number
 * has already lost exactness by the time a validator sees it, so the API
 * refuses the shape outright rather than accepting it and rounding (ADR-007).
 */
const AMOUNT_PATTERN = /^-?\d{1,16}(\.\d{1,4})?$/;

export class RecordAccountEntryDto {
  @IsIn(['PAYMENT', 'ADVANCE_PAYMENT', 'WITHHOLDING_CREDIT', 'FOREIGN_TAX_CREDIT'])
  entryType!: string;

  @IsString()
  @MaxLength(20)
  taxTypeCode!: string;

  @IsString()
  @MaxLength(9)
  assessmentYear!: string;

  @Matches(AMOUNT_PATTERN, {
    message:
      'amount must be a decimal string such as "1234.56". Numbers are refused because JSON ' +
      'numbers cannot represent money exactly (ADR-007).',
  })
  amount!: string;

  @IsString()
  @MaxLength(3)
  currencyCode!: string;

  @IsDateString()
  valueDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  creditCode?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  nonRefundable?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  sourceReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  narrative?: string;
}

@ApiTags('assessment')
@Controller()
export class EvidenceController {
  constructor(
    private readonly evidence: EvidenceService,
    private readonly accounts: AccountService,
  ) {}

  @Post('cases/:id/evidence/refresh')
  @RequirePermission(PermissionLevel.EDIT)
  @ApiOperation({
    summary: 'Retrieve evidence from every configured source and snapshot it',
    description:
      'Advances the case to DATA_READY only when every mandatory source succeeded. A failed ' +
      'mandatory source leaves the case where it is and records why.',
  })
  async refresh(@Param('id') id: string, @CurrentUser() caller: RequestContext | undefined) {
    return this.evidence.refresh(Number(id), caller!);
  }

  @Get('cases/:id/evidence')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'The current evidence snapshot and the declared items from it' })
  async current(@Param('id') id: string) {
    return this.evidence.currentFor(Number(id));
  }

  @Get('taxpayers/:taxpayerId/account')
  @RequirePermission(PermissionLevel.VIEW)
  @ApiOperation({ summary: 'Payments, credits and losses held against a taxpayer' })
  async account(@Param('taxpayerId') taxpayerId: string) {
    return this.accounts.summaryFor(Number(taxpayerId));
  }

  @Post('taxpayers/:taxpayerId/account')
  @RequirePermission(PermissionLevel.FULL)
  @ApiOperation({
    summary: 'Record a payment or credit',
    description:
      'FULL, and supervisor-only by default: an invented payment reduces an assessment as ' +
      'effectively as an invented deduction.',
  })
  async record(
    @Param('taxpayerId') taxpayerId: string,
    @Body() body: RecordAccountEntryDto,
    @CurrentUser() caller: RequestContext | undefined,
  ) {
    return this.accounts.record(Number(taxpayerId), body, caller!);
  }
}
