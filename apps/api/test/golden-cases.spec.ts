import { Money } from '@tas/decimal';
import fc from 'fast-check';
import { calculate, hashInputs } from '../src/tax-assessment/calculation/pipeline';
import {
  CalculationError,
  CalculationStep,
  type CalculationInputs,
} from '../src/tax-assessment/calculation/types';
import { SLAB_REGIME, UK_CIT_FY2024, gbp } from './fixtures/uk-cit-rule-set';

/**
 * The golden-case corpus.
 *
 * Plan reference: V2 section 26.2; ADR-006, ADR-007.
 *
 * **This suite is a CI gate.** Any change to the pipeline or to a rule set
 * must show an intentional, reviewed diff here. A plausible-looking refactor
 * that quietly changes a liability is the exact failure this exists to catch.
 *
 * Every expected figure below is one I can derive by hand from published
 * guidance, and the derivation is written next to it. A test whose expected
 * value nobody can re-derive is not a golden case — it is a snapshot of
 * whatever the code happened to do.
 *
 * Rates researched, not SME-signed. See the fixture header.
 */

const baseInputs = (overrides: Partial<CalculationInputs> = {}): CalculationInputs => ({
  currencyCode: 'GBP',
  declaredBase: gbp('0'),
  totalAdjustments: gbp('0'),
  losses: [],
  credits: [],
  amountPaid: gbp('0'),
  daysLate: 0,
  filingDaysLate: 0,
  assessmentYear: '2024',
  ...overrides,
});

describe('UK CIT — the three rate regions', () => {
  it('small profits rate below the lower limit', () => {
    // £40,000 x 19% = £7,600
    const result = calculate(baseInputs({ declaredBase: gbp('40000') }), UK_CIT_FY2024);
    expect(result.taxBeforeCredits.toString()).toBe('7600');
    expect(result.netPayableOrRefundable.toString()).toBe('7600');
  });

  it('main rate at or above the upper limit', () => {
    // £300,000 x 25% = £75,000
    const result = calculate(baseInputs({ declaredBase: gbp('300000') }), UK_CIT_FY2024);
    expect(result.taxBeforeCredits.toString()).toBe('75000');
  });

  it('marginal relief between the limits', () => {
    // £100,000 x 25%              = £25,000
    // MR = (250,000 - 100,000) x 3/200 = £2,250
    // tax = 25,000 - 2,250        = £22,750   (effective 22.75%)
    const result = calculate(baseInputs({ declaredBase: gbp('100000') }), UK_CIT_FY2024);
    expect(result.taxBeforeCredits.toString()).toBe('22750');
  });

  it('exactly at the lower limit uses the small profits rate', () => {
    // £50,000 x 19% = £9,500
    const result = calculate(baseInputs({ declaredBase: gbp('50000') }), UK_CIT_FY2024);
    expect(result.taxBeforeCredits.toString()).toBe('9500');
  });

  it('exactly at the upper limit uses the main rate with no relief', () => {
    // £250,000 x 25% = £62,500
    const result = calculate(baseInputs({ declaredBase: gbp('250000') }), UK_CIT_FY2024);
    expect(result.taxBeforeCredits.toString()).toBe('62500');
  });

  /**
   * The boundaries are continuous, and that is not a coincidence.
   *
   * The 3/200 fraction is chosen so the marginal-relief formula meets the
   * small-profits rate exactly at £50,000 and the main rate exactly at
   * £250,000. If a refactor broke the formula, this is the test most likely to
   * notice — a discontinuity of a few pounds at a boundary is invisible in a
   * single-value assertion.
   */
  it('is continuous at the lower boundary', () => {
    const atLimit = calculate(baseInputs({ declaredBase: gbp('50000') }), UK_CIT_FY2024);
    const justAbove = calculate(baseInputs({ declaredBase: gbp('50001') }), UK_CIT_FY2024);

    // 50,001 x 25% - (250,000 - 50,001) x 0.015
    //   = 12,500.25 - 2,999.985 = 9,500.265 -> £9,500
    expect(atLimit.taxBeforeCredits.toString()).toBe('9500');
    expect(justAbove.taxBeforeCredits.toString()).toBe('9500');
  });

  it('is continuous at the upper boundary', () => {
    const justBelow = calculate(baseInputs({ declaredBase: gbp('249999') }), UK_CIT_FY2024);
    const atLimit = calculate(baseInputs({ declaredBase: gbp('250000') }), UK_CIT_FY2024);

    // 249,999 x 25% - (250,000 - 249,999) x 0.015
    //   = 62,499.75 - 0.015 = 62,499.735 -> £62,500
    expect(justBelow.taxBeforeCredits.toString()).toBe('62500');
    expect(atLimit.taxBeforeCredits.toString()).toBe('62500');
  });
});

describe('UK CIT — adjustments and losses', () => {
  it('adds an adjustment to the declared base', () => {
    // declared 90,000 + adjustment 30,000 = 120,000
    // 120,000 x 25% - (250,000 - 120,000) x 0.015 = 30,000 - 1,950 = £28,050
    const result = calculate(
      baseInputs({ declaredBase: gbp('90000'), totalAdjustments: gbp('30000') }),
      UK_CIT_FY2024,
    );
    expect(result.assessedBase.toString()).toBe('120000');
    expect(result.taxBeforeCredits.toString()).toBe('28050');
  });

  it('handles a negative adjustment', () => {
    // 120,000 - 20,000 = 100,000 -> £22,750 as above
    const result = calculate(
      baseInputs({ declaredBase: gbp('120000'), totalAdjustments: gbp('-20000') }),
      UK_CIT_FY2024,
    );
    expect(result.assessedBase.toString()).toBe('100000');
    expect(result.taxBeforeCredits.toString()).toBe('22750');
  });

  it('relieves losses oldest first', () => {
    // base 100,000, losses 2021:20,000 and 2022:15,000 -> all 35,000 relieved
    // taxable 65,000 -> 65,000 x 25% - (250,000 - 65,000) x 0.015
    //   = 16,250 - 2,775 = £13,475
    const result = calculate(
      baseInputs({
        declaredBase: gbp('100000'),
        losses: [
          { originYear: '2022', amount: gbp('15000') },
          { originYear: '2021', amount: gbp('20000') },
        ],
      }),
      UK_CIT_FY2024,
    );
    expect(result.lossesSetOff.toString()).toBe('35000');
    expect(result.taxableBase.toString()).toBe('65000');
    expect(result.taxBeforeCredits.toString()).toBe('13475');
  });

  it('never relieves more loss than there is profit', () => {
    // 30,000 profit, 100,000 of losses: only 30,000 can be used.
    const result = calculate(
      baseInputs({
        declaredBase: gbp('30000'),
        losses: [{ originYear: '2020', amount: gbp('100000') }],
      }),
      UK_CIT_FY2024,
    );
    expect(result.lossesSetOff.toString()).toBe('30000');
    expect(result.taxableBase.toString()).toBe('0');
    expect(result.taxBeforeCredits.toString()).toBe('0');
  });

  it('floors a loss-making period at zero rather than producing negative tax', () => {
    const result = calculate(
      baseInputs({ declaredBase: gbp('50000'), totalAdjustments: gbp('-80000') }),
      UK_CIT_FY2024,
    );
    expect(result.assessedBase.toString()).toBe('-30000');
    expect(result.taxableBase.toString()).toBe('0');
    expect(result.taxBeforeCredits.toString()).toBe('0');
  });
});

describe('UK CIT — credits', () => {
  it('applies credits in the configured order', () => {
    // tax on 100,000 = 22,750; credits 5,000 + 2,000 = 7,000
    // after credits = £15,750
    const result = calculate(
      baseInputs({
        declaredBase: gbp('100000'),
        credits: [
          { code: 'WITHHOLDING_TAX', amount: gbp('2000') },
          { code: 'DOUBLE_TAX_RELIEF', amount: gbp('5000') },
        ],
      }),
      UK_CIT_FY2024,
    );
    expect(result.totalCredits.toString()).toBe('7000');
    expect(result.taxAfterCredits.toString()).toBe('15750');

    // Ordering is observable in the trace: double tax relief is applied first.
    const creditTrace = result.trace.filter((t) => t.step === CalculationStep.CREDITS);
    expect(creditTrace[0]?.inputs['code']).toBe('DOUBLE_TAX_RELIEF');
  });

  it('caps credits at the liability rather than creating a negative tax', () => {
    // tax 7,600; credits 20,000 available but only 7,600 usable.
    const result = calculate(
      baseInputs({
        declaredBase: gbp('40000'),
        credits: [{ code: 'WITHHOLDING_TAX', amount: gbp('20000') }],
      }),
      UK_CIT_FY2024,
    );
    expect(result.totalCredits.toString()).toBe('7600');
    expect(result.taxAfterCredits.toString()).toBe('0');
  });
});

describe('UK CIT — penalties', () => {
  it('charges nothing when filed and paid on time', () => {
    const result = calculate(baseInputs({ declaredBase: gbp('100000') }), UK_CIT_FY2024);
    expect(result.penaltyAmount.toString()).toBe('0');
    expect(result.interestAmount.toString()).toBe('0');
  });

  it('charges £100 for a return one day late', () => {
    const result = calculate(
      baseInputs({ declaredBase: gbp('100000'), filingDaysLate: 1 }),
      UK_CIT_FY2024,
    );
    expect(result.penaltyAmount.toString()).toBe('100');
  });

  it('charges a second £100 after three months', () => {
    // Both fixed penalties have now triggered: 100 + 100.
    const result = calculate(
      baseInputs({ declaredBase: gbp('100000'), filingDaysLate: 100 }),
      UK_CIT_FY2024,
    );
    expect(result.penaltyAmount.toString()).toBe('200');
  });

  it('adds 10% of the tax after six months', () => {
    // tax after credits 22,750; 10% = 2,275. Plus both £100 penalties = £2,475.
    const result = calculate(
      baseInputs({ declaredBase: gbp('100000'), filingDaysLate: 200 }),
      UK_CIT_FY2024,
    );
    expect(result.penaltyAmount.toString()).toBe('2475');
  });
});

describe('UK CIT — interest', () => {
  it('charges simple interest on tax paid late', () => {
    // 22,750 x 7.75% x 90/365 = 22,750 x 0.0775 x 0.246575...
    //   = 1,763.125 x 0.246575... = 434.7945... -> £435
    const result = calculate(
      baseInputs({ declaredBase: gbp('100000'), daysLate: 90 }),
      UK_CIT_FY2024,
    );
    expect(result.interestAmount.toString()).toBe('435');
  });

  it('charges no interest when there is no tax to pay late', () => {
    const result = calculate(baseInputs({ declaredBase: gbp('0'), daysLate: 365 }), UK_CIT_FY2024);
    expect(result.interestAmount.toString()).toBe('0');
  });

  it('refuses to compute compound interest rather than silently using simple', () => {
    // Understating a liability silently is worse than failing loudly.
    const compounding = {
      ...UK_CIT_FY2024,
      items: UK_CIT_FY2024.items.map((item) =>
        item.itemType === 'INTEREST'
          ? { ...item, parameters: { ...item.parameters, compounding: 'DAILY' } }
          : item,
      ),
    };
    expect(() =>
      calculate(baseInputs({ declaredBase: gbp('100000'), daysLate: 90 }), compounding),
    ).toThrow(/not implemented/);
  });
});

describe('UK CIT — net position', () => {
  it('reports an amount payable', () => {
    // tax 22,750, paid 10,000 -> 12,750 payable
    const result = calculate(
      baseInputs({ declaredBase: gbp('100000'), amountPaid: gbp('10000') }),
      UK_CIT_FY2024,
    );
    expect(result.netPayableOrRefundable.toString()).toBe('12750');
    expect(result.netPayableOrRefundable.isPositive()).toBe(true);
  });

  it('reports a refund as a negative net position', () => {
    // tax 7,600, paid 10,000 -> -2,400, i.e. £2,400 refundable
    const result = calculate(
      baseInputs({ declaredBase: gbp('40000'), amountPaid: gbp('10000') }),
      UK_CIT_FY2024,
    );
    expect(result.netPayableOrRefundable.toString()).toBe('-2400');
    expect(result.netPayableOrRefundable.isNegative()).toBe(true);
  });
});

describe('progressive slab regime', () => {
  it('taxes each slice at its own rate', () => {
    // 60,000:  10,000 x 10% =  1,000
    //          40,000 x 20% =  8,000
    //          10,000 x 40% =  4,000
    //                        = 13,000
    const result = calculate(baseInputs({ declaredBase: gbp('60000') }), SLAB_REGIME);
    expect(result.taxBeforeCredits.toString()).toBe('13000');
  });

  it('taxes only the bands reached', () => {
    // 8,000 x 10% = 800
    const result = calculate(baseInputs({ declaredBase: gbp('8000') }), SLAB_REGIME);
    expect(result.taxBeforeCredits.toString()).toBe('800');
  });
});

describe('the trace', () => {
  it('records every step, including the ones that did nothing', () => {
    const result = calculate(baseInputs({ declaredBase: gbp('100000') }), UK_CIT_FY2024);
    const steps = new Set(result.trace.map((entry) => entry.step));

    // "No penalty applied" is a finding a reviewer needs to see, not infer
    // from a missing line.
    for (const step of Object.values(CalculationStep)) {
      expect(steps.has(step)).toBe(true);
    }
  });

  it('numbers entries consecutively from one', () => {
    const result = calculate(baseInputs({ declaredBase: gbp('100000') }), UK_CIT_FY2024);
    expect(result.trace.map((e) => e.sequence)).toEqual(result.trace.map((_, index) => index + 1));
  });

  it('points a figure back to the rule that produced it', () => {
    const result = calculate(baseInputs({ declaredBase: gbp('100000') }), UK_CIT_FY2024);
    const marginal = result.trace.find((e) => e.descriptionKey === 'ta.calc.marginalRelief');
    expect(marginal?.ruleReference).toBe('GB-CIT-FY2024/RATE/main');
  });

  it('shows arithmetic a reviewer can check by hand', () => {
    const result = calculate(baseInputs({ declaredBase: gbp('100000') }), UK_CIT_FY2024);
    const marginal = result.trace.find((e) => e.descriptionKey === 'ta.calc.marginalRelief');
    expect(marginal?.expression).toContain('250000');
    expect(marginal?.expression).toContain('0.015');
    expect(marginal?.expression).toContain('22750');
  });

  it('pins the rule set version on the result', () => {
    const result = calculate(baseInputs({ declaredBase: gbp('100000') }), UK_CIT_FY2024);
    expect(result.ruleSetCode).toBe('GB-CIT-FY2024');
    expect(result.ruleSetVersion).toBe(1);
  });
});

describe('input validation', () => {
  it('refuses a currency the rule set does not compute in', () => {
    expect(() =>
      calculate(baseInputs({ declaredBase: Money.of('100000', 'EUR') }), UK_CIT_FY2024),
    ).toThrow(CalculationError);
  });

  it('refuses a rule set with no rate band', () => {
    const noBands = { ...UK_CIT_FY2024, items: [] };
    expect(() => calculate(baseInputs({ declaredBase: gbp('100000') }), noBands)).toThrow(
      /no rate band/,
    );
  });

  it('refuses a monetary parameter supplied as a JSON number', () => {
    // A JSON number has already been through a double. Accepting one would
    // defeat storing rule parameters as strings (ADR-007).
    const numericBound = {
      ...UK_CIT_FY2024,
      items: UK_CIT_FY2024.items.map((item) =>
        item.reference === 'GB-CIT-FY2024/RATE/main'
          ? { ...item, parameters: { ...item.parameters, lowerBound: 50000 } }
          : item,
      ),
    };
    expect(() => calculate(baseInputs({ declaredBase: gbp('100000') }), numericBound)).toThrow(
      /decimal string/,
    );
  });
});

describe('pipeline properties', () => {
  const profit = () =>
    fc
      .integer({ min: 0, max: 5_000_000 })
      .map((value) => baseInputs({ declaredBase: gbp(String(value)) }));

  it('is deterministic', () => {
    fc.assert(
      fc.property(profit(), (inputs) => {
        const a = calculate(inputs, UK_CIT_FY2024);
        const b = calculate(inputs, UK_CIT_FY2024);
        expect(a.netPayableOrRefundable.toString()).toBe(b.netPayableOrRefundable.toString());
        expect(a.trace.length).toBe(b.trace.length);
      }),
    );
  });

  it('never produces negative tax before credits', () => {
    fc.assert(
      fc.property(profit(), (inputs) => {
        expect(calculate(inputs, UK_CIT_FY2024).taxBeforeCredits.isNegative()).toBe(false);
      }),
    );
  });

  it('is monotonic: more profit never means less tax', () => {
    // The property most likely to catch a broken marginal-relief formula: a
    // taper applied the wrong way round makes tax *fall* as profit rises.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (lower, increment) => {
          const a = calculate(baseInputs({ declaredBase: gbp(String(lower)) }), UK_CIT_FY2024);
          const b = calculate(
            baseInputs({ declaredBase: gbp(String(lower + increment)) }),
            UK_CIT_FY2024,
          );
          expect(b.taxBeforeCredits.greaterThanOrEqual(a.taxBeforeCredits)).toBe(true);
        },
      ),
    );
  });

  it('hashes the same inputs to the same value', () => {
    fc.assert(
      fc.property(profit(), (inputs) => {
        expect(hashInputs(inputs, UK_CIT_FY2024)).toBe(hashInputs(inputs, UK_CIT_FY2024));
      }),
    );
  });

  it('hashes different inputs to different values', () => {
    const a = baseInputs({ declaredBase: gbp('100000') });
    const b = baseInputs({ declaredBase: gbp('100001') });
    expect(hashInputs(a, UK_CIT_FY2024)).not.toBe(hashInputs(b, UK_CIT_FY2024));
  });

  it('hashes independently of credit ordering', () => {
    // The same facts presented in a different order are the same facts.
    const a = baseInputs({
      credits: [
        { code: 'A', amount: gbp('1') },
        { code: 'B', amount: gbp('2') },
      ],
    });
    const b = baseInputs({
      credits: [
        { code: 'B', amount: gbp('2') },
        { code: 'A', amount: gbp('1') },
      ],
    });
    expect(hashInputs(a, UK_CIT_FY2024)).toBe(hashInputs(b, UK_CIT_FY2024));
  });
});
