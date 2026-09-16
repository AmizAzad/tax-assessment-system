import { Money, RoundingMode } from '@tas/decimal';
import { RuleItemType, type RuleSet } from '../../src/tax-assessment/calculation/types';

/**
 * UK Corporation Tax, financial year 2024 (from 1 April 2023).
 *
 * Plan reference: V2 sections 7.3, 15.2; ADR-006.
 *
 * ## Provenance and status
 *
 * These rates are researched from published HMRC guidance, not signed off by a
 * qualified tax professional. They are correct to the best of my knowledge and
 * are good enough to prove the engine, the trace and the golden-case harness.
 * **Before any of this touches a real taxpayer the rule set needs review by
 * someone qualified** — that is a legal question, not a technical one.
 *
 * ## The shape of UK CIT, and why it is not a slab regime
 *
 * From FY2023 the UK charges:
 *
 *   - 19% (small profits rate) where taxable profit is at or below £50,000
 *   - 25% (main rate) where profit is at or above £250,000
 *   - between the limits: main rate, less marginal relief
 *
 *     MR = (upper limit − profit) × 3/200
 *
 * Modelling this as progressive slabs would give the wrong answer. The relief
 * is a function of the *whole* profit, not of the slice above £50,000 — which
 * is exactly the kind of structure a form formula engine cannot express and
 * why the calculation is server-side.
 *
 * Every monetary parameter is a decimal **string**. A JSON number would be an
 * IEEE double, and a band boundary arriving as 49999.999999 would put a
 * company in the wrong band (ADR-007).
 */
export const UK_CIT_FY2024: RuleSet = {
  id: 1,
  code: 'GB-CIT-FY2024',
  version: 1,
  jurisdictionCode: 'GB',
  taxTypeCode: 'CIT',
  currencyCode: 'GBP',
  // Corporation tax is computed to the penny and the liability rounded down to
  // the pound in the taxpayer's favour. HALF_UP at 0 dp is the conservative
  // default here; the exact statutory rule is one for review.
  rounding: { scale: 0, mode: RoundingMode.HALF_UP },

  items: [
    {
      itemType: RuleItemType.RATE_BAND,
      sequence: 1,
      reference: 'GB-CIT-FY2024/RATE/main',
      descriptionKey: 'ta.rule.gb.cit.mainRate',
      parameters: {
        lowerBound: '50000',
        upperBound: '250000',
        rate: '0.25',
        // 3/200 exactly. Written as a decimal string so it stays exact.
        marginalReliefFraction: '0.015',
      },
    },
    {
      itemType: RuleItemType.RATE_BAND,
      sequence: 2,
      reference: 'GB-CIT-FY2024/RATE/small',
      descriptionKey: 'ta.rule.gb.cit.smallProfitsRate',
      parameters: {
        lowerBound: '0',
        upperBound: '50000',
        rate: '0.19',
        smallProfitsRate: '0.19',
      },
    },

    {
      itemType: RuleItemType.LOSS_RULE,
      sequence: 1,
      reference: 'GB-CIT-FY2024/LOSS/carryForward',
      descriptionKey: 'ta.rule.gb.cit.lossCarryForward',
      parameters: {
        // Oldest first, so a loss is relieved before it can expire.
        setOffOrder: 'OLDEST_FIRST',
      },
    },

    {
      itemType: RuleItemType.CREDIT_ORDER,
      sequence: 1,
      reference: 'GB-CIT-FY2024/CREDIT/order',
      parameters: {
        // Non-refundable credits first so a refundable one is not wasted.
        order: ['DOUBLE_TAX_RELIEF', 'WITHHOLDING_TAX', 'ADVANCE_PAYMENT'],
      },
    },

    // The late-filing penalty schedule escalates; each row triggers at its own
    // day count, so one rule set carries the whole ladder.
    {
      itemType: RuleItemType.PENALTY,
      sequence: 1,
      reference: 'GB-CIT-FY2024/PENALTY/late1day',
      descriptionKey: 'ta.rule.gb.cit.penalty.day1',
      parameters: {
        trigger: 'FILING',
        appliesAfterDays: 0,
        basis: 'FIXED',
        fixedAmount: '100',
      },
    },
    {
      itemType: RuleItemType.PENALTY,
      sequence: 2,
      reference: 'GB-CIT-FY2024/PENALTY/late3months',
      descriptionKey: 'ta.rule.gb.cit.penalty.month3',
      parameters: {
        trigger: 'FILING',
        appliesAfterDays: 90,
        basis: 'FIXED',
        fixedAmount: '100',
      },
    },
    {
      itemType: RuleItemType.PENALTY,
      sequence: 3,
      reference: 'GB-CIT-FY2024/PENALTY/late6months',
      descriptionKey: 'ta.rule.gb.cit.penalty.month6',
      parameters: {
        trigger: 'FILING',
        appliesAfterDays: 180,
        basis: 'PERCENT',
        percentRate: '0.10',
      },
    },

    {
      itemType: RuleItemType.INTEREST,
      sequence: 1,
      reference: 'GB-CIT-FY2024/INTEREST/latePayment',
      descriptionKey: 'ta.rule.gb.cit.interest.latePayment',
      parameters: {
        // HMRC late-payment interest is base rate plus 2.5%. A rate that moves
        // with the base rate belongs in an effective-dated rule set, which is
        // exactly what this is.
        annualRate: '0.0775',
        dayCount: 365,
        compounding: 'SIMPLE',
        graceDays: 0,
      },
    },
  ],
};

/** A minimal progressive-slab regime, to prove the other rate shape. */
export const SLAB_REGIME: RuleSet = {
  id: 2,
  code: 'TEST-SLAB',
  version: 1,
  jurisdictionCode: 'XX',
  taxTypeCode: 'PIT',
  currencyCode: 'GBP',
  rounding: { scale: 2, mode: RoundingMode.HALF_UP },
  items: [
    {
      itemType: RuleItemType.RATE_BAND,
      sequence: 1,
      reference: 'TEST-SLAB/RATE/band1',
      parameters: { lowerBound: '0', upperBound: '10000', rate: '0.10' },
    },
    {
      itemType: RuleItemType.RATE_BAND,
      sequence: 2,
      reference: 'TEST-SLAB/RATE/band2',
      parameters: { lowerBound: '10000', upperBound: '50000', rate: '0.20' },
    },
    {
      itemType: RuleItemType.RATE_BAND,
      sequence: 3,
      reference: 'TEST-SLAB/RATE/band3',
      parameters: { lowerBound: '50000', rate: '0.40' },
    },
  ],
};

/** Convenience for building inputs in tests. */
export function gbp(amount: string): Money {
  return Money.of(amount, 'GBP');
}
