import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Request shapes for the case endpoints.
 *
 * Plan reference: V2 section 14.5.
 *
 * ## Why these are classes
 *
 * `ValidationPipe` works from decorator metadata, and an interface leaves none
 * at runtime. Binding `@Body()` to an interface therefore disables validation
 * silently: the global pipe is configured with `whitelist` and
 * `forbidNonWhitelisted`, and neither takes effect. These endpoints were
 * written that way and consequently accepted any shape, which is how an
 * invalid `direction` reached a database CHECK constraint and surfaced as a
 * 500 instead of a 400.
 *
 * ## Amounts are strings
 *
 * A decimal string with a pattern, never `@IsNumber()`. A JSON number has
 * already lost exactness by the time a validator sees it, so the API refuses
 * the shape rather than accepting it and rounding (ADR-007).
 */
const AMOUNT = /^\d{1,16}(\.\d{1,4})?$/;
const AMOUNT_MESSAGE =
  'must be a positive decimal string such as "1234.56". Numbers are refused because JSON ' +
  'numbers cannot represent money exactly (ADR-007).';

export class CreateCaseDto {
  @IsInt()
  @IsPositive()
  taxpayerId!: number;

  @IsString()
  @MaxLength(20)
  taxTypeCode!: string;

  @IsString()
  @MaxLength(9)
  assessmentYear!: string;

  @IsIn(['DESK', 'FIELD', 'REASSESSMENT', 'BEST_JUDGEMENT'])
  assessmentType!: string;

  @IsIn(['RISK', 'RANDOM', 'NON_FILER', 'THIRD_PARTY', 'REFERRAL', 'NEW_INFORMATION'])
  triggerPath!: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  jurisdictionCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currencyCode?: string;

  @IsOptional()
  @IsISO8601()
  limitationDate?: string;
}

export class TransitionDto {
  @IsString()
  @MaxLength(40)
  action!: string;

  /**
   * Free-form context recorded on the ledger event.
   *
   * Deliberately unvalidated beyond being an object: what a transition needs
   * to record differs per action, and the state machine decides what is
   * permitted. Anything here is audit payload, never an authorisation input.
   */
  @IsOptional()
  payload?: Record<string, unknown>;

  /** Convenience fields some transitions carry, kept explicit so they survive whitelisting. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  assigneeUsername?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reason?: string;
}

export class AssignDto {
  @IsInt()
  @IsPositive()
  userId!: number;

  @IsString()
  @MaxLength(40)
  roleCode!: string;
}

export class AdjustmentDto {
  @IsString()
  @MaxLength(40)
  adjustmentType!: string;

  @IsString()
  @MaxLength(40)
  reasonCode!: string;

  @Matches(AMOUNT, { message: `amount ${AMOUNT_MESSAGE}` })
  amount!: string;

  /**
   * Which way the adjustment moves the base.
   *
   * The database has the same check. Validating here turns a constraint
   * violation, which arrives as an opaque 500, into a 400 that names the two
   * values that work.
   */
  @IsIn(['ADD', 'DEDUCT'], {
    message:
      'direction must be ADD or DEDUCT. ADD increases the assessed base, DEDUCT reduces it; ' +
      'the amount itself is always positive.',
  })
  direction!: 'ADD' | 'DEDUCT';

  @IsOptional()
  @IsString()
  @MinLength(10, {
    message: 'A narrative that says nothing is worse than none. Explain the adjustment.',
  })
  @MaxLength(8000)
  narrative?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  statutoryReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  officerOpinion?: string;

  @IsOptional()
  @IsInt()
  itemId?: number;

  @IsOptional()
  @IsInt()
  evidenceDocumentId?: number;
}
