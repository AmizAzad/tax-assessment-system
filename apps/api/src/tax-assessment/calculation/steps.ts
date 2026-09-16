import { Money } from '@tas/decimal';
import {
  CalculationError,
  CalculationStep,
  RuleItemType,
  itemsOfType,
  moneyParam,
  numberParam,
  optionalMoneyParam,
  rateParam,
  stringParam,
  trace,
  type CalculationStepHandler,
  type PipelineContext,
  type RuleItem,
} from './types';

/**
 * The nine pipeline steps.
 *
 * Plan reference: V2 sections 8.2 stage 5, 14.4; ADR-006, ADR-007.
 *
 * Each is small, independently testable, and consumes only rule-set rows of
 * its own type. Every one appends to the trace — including when it does
 * nothing, because "no penalty applied" is itself a finding a reviewer needs
 * to see rather than infer from a missing line.
 */

// ---------------------------------------------------------------- 1. base

/** Declared figure plus the net of adjustments. */
export const baseDetermination: CalculationStepHandler = {
  step: CalculationStep.BASE_DETERMINATION,
  run(context) {
    const { declaredBase, totalAdjustments } = context.inputs;
    context.assessedBase = declaredBase.add(totalAdjustments);

    trace(
      context,
      CalculationStep.BASE_DETERMINATION,
      'ta.calc.baseDetermination',
      `${declaredBase.toString()} + ${totalAdjustments.toString()} = ${context.assessedBase.toString()}`,
      { declaredBase: declaredBase.toString(), totalAdjustments: totalAdjustments.toString() },
      context.assessedBase,
    );
  },
};

// ----------------------------------------------------------- 2. loss set-off

/**
 * Set losses against the assessed base.
 *
 * Order matters and is configuration: some jurisdictions require oldest-first
 * so that losses expire in sequence, others let the taxpayer choose. A cap
 * expressed as a percentage of the profit is common and is applied before the
 * losses are consumed.
 *
 * Losses never take the base below zero: an unrelieved loss is carried
 * forward, not turned into a negative liability.
 */
export const lossSetOff: CalculationStepHandler = {
  step: CalculationStep.LOSS_SET_OFF,
  run(context) {
    const rules = itemsOfType(context.ruleSet, RuleItemType.LOSS_RULE);
    const currency = context.currency;

    if (context.inputs.losses.length === 0 || rules.length === 0) {
      context.lossesSetOff = Money.zero(currency);
      trace(
        context,
        CalculationStep.LOSS_SET_OFF,
        'ta.calc.lossSetOff.none',
        'No losses available or no loss rule in force',
        {},
        context.lossesSetOff,
      );
      return;
    }

    const rule = rules[0]!;
    const order = stringParam(rule, 'setOffOrder', 'OLDEST_FIRST');
    const capPercent = rule.parameters['capPercent'];

    // The most that may be relieved this period.
    let ceiling = context.assessedBase.isPositive() ? context.assessedBase : Money.zero(currency);

    if (typeof capPercent === 'string') {
      const capped = ceiling.multiply(Money.percent(capPercent));
      ceiling = Money.min(ceiling, capped);
    }

    const ordered = [...context.inputs.losses].sort((a, b) =>
      order === 'NEWEST_FIRST'
        ? b.originYear.localeCompare(a.originYear)
        : a.originYear.localeCompare(b.originYear),
    );

    let remaining = ceiling;
    let used = Money.zero(currency);
    const consumed: string[] = [];

    for (const loss of ordered) {
      if (!remaining.isPositive()) break;
      const take = Money.min(loss.amount, remaining);
      used = used.add(take);
      remaining = remaining.subtract(take);
      consumed.push(`${loss.originYear}:${take.toString()}`);
    }

    context.lossesSetOff = used;

    trace(
      context,
      CalculationStep.LOSS_SET_OFF,
      'ta.calc.lossSetOff',
      `${order}, ceiling ${ceiling.toString()} -> relieved ${used.toString()}`,
      { ceiling: ceiling.toString(), consumed: consumed.join(', ') || 'none' },
      used,
      rule.reference,
    );
  },
};

// ------------------------------------------------------------ 3. taxable base

/**
 * Assessed base less losses, rounded to the statutory scale.
 *
 * This is the first place rounding is applied. Intermediate values are held at
 * full precision until here, because rounding early and often is itself a
 * source of disputes.
 */
export const taxableBase: CalculationStepHandler = {
  step: CalculationStep.TAXABLE_BASE,
  run(context) {
    const beforeRounding = context.assessedBase.subtract(context.lossesSetOff);

    // A negative taxable base is a loss, not a negative tax. Floor at zero and
    // let the unrelieved amount carry forward.
    const floored = beforeRounding.isNegative() ? Money.zero(context.currency) : beforeRounding;
    context.taxableBase = floored.round(context.ruleSet.rounding);

    trace(
      context,
      CalculationStep.TAXABLE_BASE,
      'ta.calc.taxableBase',
      `(${context.assessedBase.toString()} - ${context.lossesSetOff.toString()}) rounded ` +
        `${context.ruleSet.rounding.mode} to ${context.ruleSet.rounding.scale} dp ` +
        `= ${context.taxableBase.toString()}`,
      {
        assessedBase: context.assessedBase.toString(),
        lossesSetOff: context.lossesSetOff.toString(),
        roundingMode: context.ruleSet.rounding.mode,
      },
      context.taxableBase,
    );
  },
};

// -------------------------------------------------------- 4. rate application

/**
 * Apply the rate structure.
 *
 * Supports two shapes, because real regimes use both:
 *
 * **Progressive slabs** — each band taxes only the slice of profit falling
 * within it. Income tax works this way.
 *
 * **Single-rate with marginal relief** — the whole profit is taxed at the main
 * rate, then relief tapers the result for profits between a lower and upper
 * limit. UK corporation tax works this way, and modelling it as slabs would
 * give the wrong answer: the relief is a function of the *whole* profit, not
 * of a slice.
 *
 * A minimum tax, where configured, is applied after the bands.
 */
export const rateApplication: CalculationStepHandler = {
  step: CalculationStep.RATE_APPLICATION,
  run(context) {
    const bands = itemsOfType(context.ruleSet, RuleItemType.RATE_BAND);
    const currency = context.currency;
    const profit = context.taxableBase;

    if (bands.length === 0) {
      throw new CalculationError(
        `Rule set ${context.ruleSet.code} v${context.ruleSet.version} has no rate band. ` +
          `A liability cannot be computed without one.`,
        CalculationStep.RATE_APPLICATION,
        'NO_EFFECTIVE_RULE',
      );
    }

    const marginalBand = bands.find(
      (band) => band.parameters['marginalReliefFraction'] !== undefined,
    );

    let tax =
      marginalBand === undefined
        ? applyProgressiveBands(context, bands, profit)
        : applyMarginalRelief(context, marginalBand, bands, profit);

    // A minimum tax floors the liability regardless of the band outcome.
    const minimumRules = itemsOfType(context.ruleSet, RuleItemType.MIN_TAX);
    for (const rule of minimumRules) {
      const minimum = moneyParam(rule, 'amount', currency, CalculationStep.RATE_APPLICATION);
      if (minimum.greaterThan(tax)) {
        trace(
          context,
          CalculationStep.RATE_APPLICATION,
          'ta.calc.minimumTax',
          `computed ${tax.toString()} is below the minimum ${minimum.toString()}`,
          { computed: tax.toString(), minimum: minimum.toString() },
          minimum,
          rule.reference,
        );
        tax = minimum;
      }
    }

    context.taxBeforeCredits = tax.round(context.ruleSet.rounding);

    trace(
      context,
      CalculationStep.RATE_APPLICATION,
      'ta.calc.taxBeforeCredits',
      `tax on ${profit.toString()} = ${context.taxBeforeCredits.toString()}`,
      { taxableBase: profit.toString() },
      context.taxBeforeCredits,
    );
  },
};

/** Each band taxes only the slice of profit inside it. */
function applyProgressiveBands(
  context: PipelineContext,
  bands: readonly RuleItem[],
  profit: Money,
): Money {
  const currency = context.currency;
  let tax = Money.zero(currency);

  for (const band of bands) {
    const lower = moneyParam(band, 'lowerBound', currency, CalculationStep.RATE_APPLICATION);
    const upper = optionalMoneyParam(
      band,
      'upperBound',
      currency,
      CalculationStep.RATE_APPLICATION,
    );
    const rate = rateParam(band, 'rate', CalculationStep.RATE_APPLICATION);

    if (!profit.greaterThan(lower)) continue;

    const ceiling = upper === undefined ? profit : Money.min(profit, upper);
    const slice = ceiling.subtract(lower);
    if (!slice.isPositive()) continue;

    const bandTax = slice.multiply(rate);
    tax = tax.add(bandTax);

    trace(
      context,
      CalculationStep.RATE_APPLICATION,
      'ta.calc.rateBand',
      `${slice.toString()} x ${rate.toFixed()} = ${bandTax.toString()}`,
      {
        lowerBound: lower.toString(),
        upperBound: upper?.toString() ?? 'none',
        rate: rate.toFixed(),
        slice: slice.toString(),
      },
      bandTax,
      band.reference,
    );
  }

  return tax;
}

/**
 * Single main rate, then taper relief between a lower and upper limit.
 *
 * UK corporation tax from FY2023:
 *
 *   tax = profit x mainRate − MR
 *   MR  = (upperLimit − profit) x fraction        [when lower < profit < upper]
 *
 * Below the lower limit the small-profits rate applies to the whole profit;
 * at or above the upper limit the main rate applies with no relief.
 *
 * The published fraction is 3/200. Expressing it as a decimal string in the
 * rule set keeps it exact (ADR-007).
 */
function applyMarginalRelief(
  context: PipelineContext,
  band: RuleItem,
  allBands: readonly RuleItem[],
  profit: Money,
): Money {
  const currency = context.currency;
  const step = CalculationStep.RATE_APPLICATION;

  const lowerLimit = moneyParam(band, 'lowerBound', currency, step);
  const upperLimit = moneyParam(band, 'upperBound', currency, step);
  const mainRate = rateParam(band, 'rate', step);
  const fraction = rateParam(band, 'marginalReliefFraction', step);

  // Below the lower limit: the small-profits rate on the whole profit.
  if (!profit.greaterThan(lowerLimit)) {
    const smallBand = allBands.find((b) => b.parameters['smallProfitsRate'] !== undefined);
    const smallRate =
      smallBand === undefined ? mainRate : rateParam(smallBand, 'smallProfitsRate', step);
    const tax = profit.multiply(smallRate);

    trace(
      context,
      step,
      'ta.calc.smallProfitsRate',
      `${profit.toString()} x ${smallRate.toFixed()} = ${tax.toString()} ` +
        `(at or below the lower limit ${lowerLimit.toString()})`,
      { profit: profit.toString(), rate: smallRate.toFixed() },
      tax,
      band.reference,
    );
    return tax;
  }

  const atMainRate = profit.multiply(mainRate);

  // At or above the upper limit: main rate, no relief.
  if (!profit.lessThan(upperLimit)) {
    trace(
      context,
      step,
      'ta.calc.mainRate',
      `${profit.toString()} x ${mainRate.toFixed()} = ${atMainRate.toString()} ` +
        `(at or above the upper limit ${upperLimit.toString()}, no relief)`,
      { profit: profit.toString(), rate: mainRate.toFixed() },
      atMainRate,
      band.reference,
    );
    return atMainRate;
  }

  // Between the limits: taper.
  const relief = upperLimit.subtract(profit).multiply(fraction);
  const tax = atMainRate.subtract(relief);

  trace(
    context,
    step,
    'ta.calc.marginalRelief',
    `(${upperLimit.toString()} - ${profit.toString()}) x ${fraction.toFixed()} ` +
      `= ${relief.toString()} relief; ${atMainRate.toString()} - ${relief.toString()} ` +
      `= ${tax.toString()}`,
    {
      profit: profit.toString(),
      mainRate: mainRate.toFixed(),
      upperLimit: upperLimit.toString(),
      fraction: fraction.toFixed(),
      relief: relief.toString(),
    },
    tax,
    band.reference,
  );

  return tax;
}

// ---------------------------------------------------------------- 5. surcharge

export const surcharge: CalculationStepHandler = {
  step: CalculationStep.SURCHARGE,
  run(context) {
    const rules = itemsOfType(context.ruleSet, RuleItemType.SURCHARGE);
    const currency = context.currency;
    let total = Money.zero(currency);

    for (const rule of rules) {
      const threshold = optionalMoneyParam(rule, 'threshold', currency, CalculationStep.SURCHARGE);
      if (threshold !== undefined && !context.taxableBase.greaterThan(threshold)) {
        continue;
      }
      const rate = rateParam(rule, 'rate', CalculationStep.SURCHARGE);
      const amount = context.taxBeforeCredits.multiply(rate);
      total = total.add(amount);

      trace(
        context,
        CalculationStep.SURCHARGE,
        'ta.calc.surcharge',
        `${context.taxBeforeCredits.toString()} x ${rate.toFixed()} = ${amount.toString()}`,
        { rate: rate.toFixed(), threshold: threshold?.toString() ?? 'none' },
        amount,
        rule.reference,
      );
    }

    context.surchargeAmount = total.round(context.ruleSet.rounding);

    if (rules.length === 0) {
      trace(
        context,
        CalculationStep.SURCHARGE,
        'ta.calc.surcharge.none',
        'No surcharge in force',
        {},
        context.surchargeAmount,
      );
    }
  },
};

// ----------------------------------------------------------------- 6. credits

/**
 * Apply credits in the configured order, capped at the liability.
 *
 * Order matters where credits differ in refundability: a non-refundable
 * credit used first would waste a refundable one. The order comes from the
 * rule set; anything not named is applied last.
 */
export const credits: CalculationStepHandler = {
  step: CalculationStep.CREDITS,
  run(context) {
    const currency = context.currency;
    const liability = context.taxBeforeCredits.add(context.surchargeAmount);

    const orderRules = itemsOfType(context.ruleSet, RuleItemType.CREDIT_ORDER);
    const configured = orderRules.flatMap((rule) => {
      const order = rule.parameters['order'];
      return Array.isArray(order) ? order.map(String) : [];
    });

    const ordered = [...context.inputs.credits].sort((a, b) => {
      const ai = configured.indexOf(a.code);
      const bi = configured.indexOf(b.code);
      return (
        (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
      );
    });

    let remaining = liability;
    let applied = Money.zero(currency);

    for (const credit of ordered) {
      // Credits cannot create a refund of tax never charged. An excess
      // refundable credit is a separate repayment claim, not a negative tax.
      const usable = Money.min(credit.amount, remaining);
      if (!usable.isPositive()) {
        trace(
          context,
          CalculationStep.CREDITS,
          'ta.calc.credit.unused',
          `${credit.code}: ${credit.amount.toString()} unused, liability already extinguished`,
          { code: credit.code, available: credit.amount.toString() },
          Money.zero(currency),
        );
        continue;
      }

      applied = applied.add(usable);
      remaining = remaining.subtract(usable);

      trace(
        context,
        CalculationStep.CREDITS,
        'ta.calc.credit',
        `${credit.code}: ${usable.toString()} applied of ${credit.amount.toString()} available`,
        { code: credit.code, available: credit.amount.toString() },
        usable,
      );
    }

    context.totalCredits = applied.round(context.ruleSet.rounding);
    context.taxAfterCredits = liability.subtract(context.totalCredits);

    trace(
      context,
      CalculationStep.CREDITS,
      'ta.calc.taxAfterCredits',
      `${liability.toString()} - ${context.totalCredits.toString()} = ${context.taxAfterCredits.toString()}`,
      { liability: liability.toString(), credits: context.totalCredits.toString() },
      context.taxAfterCredits,
    );
  },
};

// ----------------------------------------------------------------- 7. penalty

/**
 * Statutory penalties.
 *
 * Three bases, all of which appear in real regimes:
 *
 *   FIXED       a flat amount
 *   PERCENT     a percentage of the tax due
 *   GREATER_OF  the larger of the two
 *
 * `GREATER_OF` is the shape the form formula engine cannot express at all —
 * it has no MAX — and is part of why computation is server-side (ADR-006).
 *
 * A penalty applies only once its trigger day count has passed, so the same
 * rule set carries the whole escalating schedule.
 */
export const penalty: CalculationStepHandler = {
  step: CalculationStep.PENALTY,
  run(context) {
    const rules = itemsOfType(context.ruleSet, RuleItemType.PENALTY);
    const currency = context.currency;
    let total = Money.zero(currency);

    for (const rule of rules) {
      const appliesAfterDays = numberParam(rule, 'appliesAfterDays', 0);
      const trigger = stringParam(rule, 'trigger', 'FILING');
      const daysLate =
        trigger === 'PAYMENT' ? context.inputs.daysLate : context.inputs.filingDaysLate;

      if (daysLate <= appliesAfterDays) continue;

      const basis = stringParam(rule, 'basis', 'FIXED');
      const fixed = optionalMoneyParam(rule, 'fixedAmount', currency, CalculationStep.PENALTY);
      const percentRate =
        rule.parameters['percentRate'] === undefined
          ? undefined
          : rateParam(rule, 'percentRate', CalculationStep.PENALTY);

      let amount: Money;
      let expression: string;

      switch (basis) {
        case 'FIXED':
          amount = fixed ?? Money.zero(currency);
          // `daysLate`, not `appliesAfterDays`. The threshold is why the
          // penalty applies; how late the taxpayer actually was is what they
          // need to see on the notice, and printing the threshold alone reads
          // as though nothing was late at all.
          expression =
            `fixed ${amount.toString()}: ${daysLate} days late, ` +
            `charged beyond ${appliesAfterDays} days`;
          break;

        case 'PERCENT': {
          const rate = percentRate ?? Money.rate('0');
          amount = context.taxAfterCredits.multiply(rate);
          expression = `${context.taxAfterCredits.toString()} x ${rate.toFixed()} = ${amount.toString()}`;
          break;
        }

        case 'GREATER_OF': {
          const byPercent = context.taxAfterCredits.multiply(percentRate ?? Money.rate('0'));
          const byFixed = fixed ?? Money.zero(currency);
          amount = Money.max(byFixed, byPercent);
          expression =
            `greater of fixed ${byFixed.toString()} and ` +
            `${context.taxAfterCredits.toString()} x ${(percentRate ?? Money.rate('0')).toFixed()} ` +
            `= ${byPercent.toString()} -> ${amount.toString()}`;
          break;
        }

        default:
          throw new CalculationError(
            `Rule ${rule.reference} has unknown penalty basis '${basis}'`,
            CalculationStep.PENALTY,
            'INVALID_PARAMETER',
          );
      }

      const cap = optionalMoneyParam(rule, 'cap', currency, CalculationStep.PENALTY);
      if (cap !== undefined && amount.greaterThan(cap)) {
        expression += ` (capped at ${cap.toString()})`;
        amount = cap;
      }

      total = total.add(amount);

      trace(
        context,
        CalculationStep.PENALTY,
        'ta.calc.penalty',
        expression,
        { basis, daysLate: String(daysLate), trigger },
        amount,
        rule.reference,
      );
    }

    context.penaltyAmount = total.round(context.ruleSet.rounding);

    if (total.isZero()) {
      trace(
        context,
        CalculationStep.PENALTY,
        'ta.calc.penalty.none',
        'No penalty applies',
        {
          filingDaysLate: String(context.inputs.filingDaysLate),
          paymentDaysLate: String(context.inputs.daysLate),
        },
        context.penaltyAmount,
      );
    }
  },
};

// ---------------------------------------------------------------- 8. interest

/**
 * Interest on tax paid late.
 *
 * Simple interest on a day-count basis. The day count is configuration
 * because it varies — 365, 366 in a leap year, or a commercial 360 — and the
 * difference is real money over a long delay.
 *
 * Compound interest is deliberately not implemented rather than approximated:
 * a wrong compounding basis is a wrong liability, and no jurisdiction in scope
 * needs it yet. It throws rather than silently computing simple interest.
 */
export const interest: CalculationStepHandler = {
  step: CalculationStep.INTEREST,
  run(context) {
    const rules = itemsOfType(context.ruleSet, RuleItemType.INTEREST);
    const currency = context.currency;
    const daysLate = context.inputs.daysLate;

    if (rules.length === 0 || daysLate <= 0 || !context.taxAfterCredits.isPositive()) {
      context.interestAmount = Money.zero(currency);
      trace(
        context,
        CalculationStep.INTEREST,
        'ta.calc.interest.none',
        daysLate <= 0 ? 'Paid on time' : 'No interest rule in force',
        { daysLate: String(daysLate) },
        context.interestAmount,
      );
      return;
    }

    let total = Money.zero(currency);

    for (const rule of rules) {
      const compounding = stringParam(rule, 'compounding', 'SIMPLE');
      if (compounding !== 'SIMPLE') {
        throw new CalculationError(
          `Rule ${rule.reference} asks for ${compounding} interest, which is not implemented. ` +
            `Computing simple interest instead would understate the liability.`,
          CalculationStep.INTEREST,
          'INVALID_PARAMETER',
        );
      }

      const annualRate = rateParam(rule, 'annualRate', CalculationStep.INTEREST);
      const dayCount = numberParam(rule, 'dayCount', 365);
      const graceDays = numberParam(rule, 'graceDays', 0);
      const chargeableDays = daysLate - graceDays;
      if (chargeableDays <= 0) continue;

      // principal x rate x days / dayCount
      const amount = context.taxAfterCredits
        .multiply(annualRate)
        .multiply(String(chargeableDays))
        .divide(String(dayCount));

      total = total.add(amount);

      trace(
        context,
        CalculationStep.INTEREST,
        'ta.calc.interest',
        `${context.taxAfterCredits.toString()} x ${annualRate.toFixed()} x ` +
          `${chargeableDays}/${dayCount} = ${amount.toString()}`,
        {
          principal: context.taxAfterCredits.toString(),
          annualRate: annualRate.toFixed(),
          chargeableDays: String(chargeableDays),
          dayCount: String(dayCount),
        },
        amount,
        rule.reference,
      );
    }

    context.interestAmount = total.round(context.ruleSet.rounding);
  },
};

// ----------------------------------------------------------- 9. net position

export const netPosition: CalculationStepHandler = {
  step: CalculationStep.NET_POSITION,
  run(context) {
    const totalPayable = context.taxAfterCredits
      .add(context.penaltyAmount)
      .add(context.interestAmount);

    const net = totalPayable.subtract(context.inputs.amountPaid);

    trace(
      context,
      CalculationStep.NET_POSITION,
      'ta.calc.netPosition',
      `(${context.taxAfterCredits.toString()} + ${context.penaltyAmount.toString()} + ` +
        `${context.interestAmount.toString()}) - ${context.inputs.amountPaid.toString()} ` +
        `= ${net.toString()} (${net.isNegative() ? 'refund due' : 'payable'})`,
      {
        taxAfterCredits: context.taxAfterCredits.toString(),
        penalty: context.penaltyAmount.toString(),
        interest: context.interestAmount.toString(),
        amountPaid: context.inputs.amountPaid.toString(),
      },
      net,
    );
  },
};

/** The pipeline, in order. */
export const PIPELINE: readonly CalculationStepHandler[] = [
  baseDetermination,
  lossSetOff,
  taxableBase,
  rateApplication,
  surcharge,
  credits,
  penalty,
  interest,
  netPosition,
];
