import { Money } from '@tas/decimal';
import { createHash } from 'node:crypto';
import { PIPELINE } from './steps';
import {
  CalculationError,
  CalculationStep,
  type CalculationInputs,
  type CalculationResult,
  type PipelineContext,
  type RuleSet,
} from './types';

/**
 * Runs the calculation pipeline.
 *
 * Plan reference: V2 sections 8.2 stage 5, 14.4; ADR-006, ADR-007.
 *
 * ## Pure, on purpose
 *
 * No clock, no database, no randomness. Everything is resolved by the caller
 * and passed in. Three things follow, and they are the reason the plan calls
 * this the critical component:
 *
 *   - **Reproducible.** The same inputs and rule-set version always produce
 *     the same figure and the same trace. An assessment defended four years
 *     later can be recomputed exactly.
 *   - **Testable.** The golden-case corpus runs against this function with no
 *     infrastructure at all.
 *   - **Idempotent.** Re-running changes nothing, so a retried service task
 *     cannot corrupt a case.
 */
export function calculate(inputs: CalculationInputs, ruleSet: RuleSet): CalculationResult {
  assertCurrenciesAgree(inputs, ruleSet);

  const context: PipelineContext = {
    inputs,
    ruleSet,
    currency: ruleSet.currencyCode,
    trace: [],
    assessedBase: Money.zero(ruleSet.currencyCode),
    lossesSetOff: Money.zero(ruleSet.currencyCode),
    taxableBase: Money.zero(ruleSet.currencyCode),
    taxBeforeCredits: Money.zero(ruleSet.currencyCode),
    surchargeAmount: Money.zero(ruleSet.currencyCode),
    totalCredits: Money.zero(ruleSet.currencyCode),
    taxAfterCredits: Money.zero(ruleSet.currencyCode),
    penaltyAmount: Money.zero(ruleSet.currencyCode),
    interestAmount: Money.zero(ruleSet.currencyCode),
  };

  for (const step of PIPELINE) {
    step.run(context);
  }

  const totalPayable = context.taxAfterCredits
    .add(context.penaltyAmount)
    .add(context.interestAmount);

  return {
    declaredBase: inputs.declaredBase,
    totalAdjustments: inputs.totalAdjustments,
    assessedBase: context.assessedBase,
    lossesSetOff: context.lossesSetOff,
    taxableBase: context.taxableBase,
    taxBeforeCredits: context.taxBeforeCredits,
    surchargeAmount: context.surchargeAmount,
    totalCredits: context.totalCredits,
    taxAfterCredits: context.taxAfterCredits,
    penaltyAmount: context.penaltyAmount,
    interestAmount: context.interestAmount,
    totalPayable,
    amountPaid: inputs.amountPaid,
    netPayableOrRefundable: totalPayable.subtract(inputs.amountPaid),
    currencyCode: ruleSet.currencyCode,
    ruleSetCode: ruleSet.code,
    ruleSetVersion: ruleSet.version,
    trace: context.trace,
  };
}

/**
 * A stable hash of everything the pipeline read.
 *
 * Stored on the result. Two results with the same hash and the same rule-set
 * version must agree — if they do not, something is wrong with the pipeline
 * rather than with the data, and that is worth being able to detect.
 *
 * Keys are sorted so that property order cannot change the hash.
 */
export function hashInputs(inputs: CalculationInputs, ruleSet: RuleSet): string {
  const canonical = {
    currencyCode: inputs.currencyCode,
    declaredBase: inputs.declaredBase.toString(),
    totalAdjustments: inputs.totalAdjustments.toString(),
    losses: [...inputs.losses].map((loss) => `${loss.originYear}:${loss.amount.toString()}`).sort(),
    credits: [...inputs.credits]
      .map((credit) => `${credit.code}:${credit.amount.toString()}`)
      .sort(),
    amountPaid: inputs.amountPaid.toString(),
    daysLate: inputs.daysLate,
    filingDaysLate: inputs.filingDaysLate,
    assessmentYear: inputs.assessmentYear,
    ruleSetCode: ruleSet.code,
    ruleSetVersion: ruleSet.version,
  };

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Every amount must be in the rule set's currency.
 *
 * Checked once up front rather than discovered mid-pipeline, so the error
 * names the problem rather than surfacing as a currency mismatch six steps in.
 */
function assertCurrenciesAgree(inputs: CalculationInputs, ruleSet: RuleSet): void {
  const expected = ruleSet.currencyCode;

  const mismatches: string[] = [];
  if (inputs.declaredBase.currency !== expected) mismatches.push('declaredBase');
  if (inputs.totalAdjustments.currency !== expected) mismatches.push('totalAdjustments');
  if (inputs.amountPaid.currency !== expected) mismatches.push('amountPaid');
  for (const loss of inputs.losses) {
    if (loss.amount.currency !== expected) mismatches.push(`loss ${loss.originYear}`);
  }
  for (const credit of inputs.credits) {
    if (credit.amount.currency !== expected) mismatches.push(`credit ${credit.code}`);
  }

  if (mismatches.length > 0) {
    throw new CalculationError(
      `Rule set ${ruleSet.code} computes in ${expected}, but these inputs are in another ` +
        `currency: ${mismatches.join(', ')}. Convert explicitly before calculating.`,
      CalculationStep.BASE_DETERMINATION,
      'CURRENCY_MISMATCH',
    );
  }
}
