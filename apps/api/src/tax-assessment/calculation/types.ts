import { Money, RoundingMode, type RoundingRule } from '@tas/decimal';

/**
 * The calculation pipeline's contract.
 *
 * Plan reference: V2 sections 8.2 stage 5, 14.4; ADR-006, ADR-007.
 *
 * ## The pipeline is pure
 *
 * No clock reads, no database reads, no randomness inside a step. Everything
 * is resolved before it runs and hashed into `inputsHash`. That is what makes
 * the golden-case harness possible, and what makes an assessment reproducible
 * in an appeal four years later: the same inputs and the same rule-set version
 * always produce the same figure and the same trace.
 */

/** The nine steps, in order. Plan section 14.4. */
export enum CalculationStep {
  BASE_DETERMINATION = 'BASE_DETERMINATION',
  LOSS_SET_OFF = 'LOSS_SET_OFF',
  TAXABLE_BASE = 'TAXABLE_BASE',
  RATE_APPLICATION = 'RATE_APPLICATION',
  SURCHARGE = 'SURCHARGE',
  CREDITS = 'CREDITS',
  PENALTY = 'PENALTY',
  INTEREST = 'INTEREST',
  NET_POSITION = 'NET_POSITION',
}

export enum RuleItemType {
  RATE_BAND = 'RATE_BAND',
  THRESHOLD = 'THRESHOLD',
  CREDIT_ORDER = 'CREDIT_ORDER',
  PENALTY = 'PENALTY',
  INTEREST = 'INTEREST',
  LOSS_RULE = 'LOSS_RULE',
  MIN_TAX = 'MIN_TAX',
  SURCHARGE = 'SURCHARGE',
}

/**
 * One rule from a published rule set.
 *
 * `parameters` holds monetary values as **strings**, never JSON numbers: a
 * JSON number is an IEEE double, and a band boundary that arrived as
 * 49999.999999 would put a taxpayer in the wrong band (ADR-007).
 */
export interface RuleItem {
  readonly itemType: RuleItemType;
  readonly sequence: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly descriptionKey?: string;
  /** Identifies the row, so a figure in the trace points back to a rule. */
  readonly reference: string;
}

export interface RuleSet {
  readonly id: number;
  readonly code: string;
  readonly version: number;
  readonly jurisdictionCode: string;
  readonly taxTypeCode: string;
  readonly currencyCode: string;
  readonly rounding: RoundingRule;
  readonly items: readonly RuleItem[];
}

/** One credit reducing the liability, e.g. withholding tax already suffered. */
export interface CreditInput {
  readonly code: string;
  readonly amount: Money;
}

/** A loss available to set against this period's profit. */
export interface LossInput {
  readonly originYear: string;
  readonly amount: Money;
}

/**
 * Everything the pipeline reads.
 *
 * Resolved before the pipeline runs, so the computation itself touches
 * nothing external.
 */
export interface CalculationInputs {
  readonly currencyCode: string;
  /** The taxpayer's declared figure for the period. */
  readonly declaredBase: Money;
  /** Signed net of all adjustments: positive increases the base. */
  readonly totalAdjustments: Money;
  readonly losses: readonly LossInput[];
  readonly credits: readonly CreditInput[];
  readonly amountPaid: Money;
  /** Whole days the payment is late. Computed by the deadline engine, not here. */
  readonly daysLate: number;
  /** Whole days the return was filed late, for filing penalties. */
  readonly filingDaysLate: number;
  /** Assessment year, for rules that vary by year. */
  readonly assessmentYear: string;
}

export interface TraceEntry {
  readonly sequence: number;
  readonly step: CalculationStep;
  readonly descriptionKey: string;
  /** Human-readable arithmetic, so a reviewer can check it by hand. */
  readonly expression: string;
  readonly inputs: Readonly<Record<string, string>>;
  readonly output: Money;
  readonly ruleReference?: string;
}

export interface CalculationResult {
  readonly declaredBase: Money;
  readonly totalAdjustments: Money;
  readonly assessedBase: Money;
  readonly lossesSetOff: Money;
  readonly taxableBase: Money;
  readonly taxBeforeCredits: Money;
  readonly surchargeAmount: Money;
  readonly totalCredits: Money;
  readonly taxAfterCredits: Money;
  readonly penaltyAmount: Money;
  readonly interestAmount: Money;
  readonly totalPayable: Money;
  readonly amountPaid: Money;
  /** Positive means the taxpayer owes; negative means a refund is due. */
  readonly netPayableOrRefundable: Money;
  readonly currencyCode: string;
  readonly ruleSetCode: string;
  readonly ruleSetVersion: number;
  readonly trace: readonly TraceEntry[];
}

/** Carried between steps. Each step reads what it needs and adds its output. */
export interface PipelineContext {
  readonly inputs: CalculationInputs;
  readonly ruleSet: RuleSet;
  readonly currency: string;
  /** Mutable accumulator. Steps append; nothing rewrites an earlier entry. */
  readonly trace: TraceEntry[];

  assessedBase: Money;
  lossesSetOff: Money;
  taxableBase: Money;
  taxBeforeCredits: Money;
  surchargeAmount: Money;
  totalCredits: Money;
  taxAfterCredits: Money;
  penaltyAmount: Money;
  interestAmount: Money;
}

export interface CalculationStepHandler {
  readonly step: CalculationStep;
  run(context: PipelineContext): void;
}

export class CalculationError extends Error {
  constructor(
    message: string,
    readonly step: CalculationStep,
    readonly reason:
      'NO_EFFECTIVE_RULE' | 'AMBIGUOUS_RULE' | 'INVALID_PARAMETER' | 'CURRENCY_MISMATCH',
  ) {
    super(message);
    this.name = 'CalculationError';
  }
}

// -------------------------------------------------------------- parameters

/**
 * Read a monetary parameter.
 *
 * Insists on a string. A JSON number here has already been through a double,
 * and silently accepting one would defeat the point of storing rule
 * parameters as strings.
 */
export function moneyParam(
  item: RuleItem,
  name: string,
  currency: string,
  step: CalculationStep,
): Money {
  const raw = item.parameters[name];
  if (typeof raw !== 'string') {
    throw new CalculationError(
      `Rule ${item.reference} parameter '${name}' must be a decimal string, not ` +
        `${typeof raw}. A JSON number has already lost precision (ADR-007).`,
      step,
      'INVALID_PARAMETER',
    );
  }
  return Money.of(raw, currency);
}

export function optionalMoneyParam(
  item: RuleItem,
  name: string,
  currency: string,
  step: CalculationStep,
): Money | undefined {
  return item.parameters[name] === undefined ? undefined : moneyParam(item, name, currency, step);
}

/** Read a rate. Also a string, for the same reason. */
export function rateParam(item: RuleItem, name: string, step: CalculationStep) {
  const raw = item.parameters[name];
  if (typeof raw !== 'string') {
    throw new CalculationError(
      `Rule ${item.reference} parameter '${name}' must be a decimal string, not ${typeof raw}.`,
      step,
      'INVALID_PARAMETER',
    );
  }
  return Money.rate(raw);
}

export function stringParam(item: RuleItem, name: string, fallback: string): string {
  const raw = item.parameters[name];
  return typeof raw === 'string' ? raw : fallback;
}

export function numberParam(item: RuleItem, name: string, fallback: number): number {
  const raw = item.parameters[name];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

export function itemsOfType(ruleSet: RuleSet, itemType: RuleItemType): readonly RuleItem[] {
  return ruleSet.items
    .filter((item) => item.itemType === itemType)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);
}

/** Append a trace entry. Every step records what it did, even a no-op. */
export function trace(
  context: PipelineContext,
  step: CalculationStep,
  descriptionKey: string,
  expression: string,
  inputs: Readonly<Record<string, string>>,
  output: Money,
  ruleReference?: string,
): void {
  context.trace.push({
    sequence: context.trace.length + 1,
    step,
    descriptionKey,
    expression,
    inputs,
    output,
    ruleReference,
  });
}

export { RoundingMode };
export type { RoundingRule };
