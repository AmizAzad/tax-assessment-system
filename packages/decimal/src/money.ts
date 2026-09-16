import Decimal from 'decimal.js';
import { RoundingRule, toDecimalJsRounding } from './rounding';

/**
 * Internal working precision.
 *
 * Intermediate results are held at high precision and only rounded when a
 * statutory rule says to round. 34 significant digits is IEEE 754-2008
 * decimal128, which is comfortably more than any tax computation needs and
 * leaves no room for a precision argument in an appeal.
 */
Decimal.set({ precision: 34, toExpNeg: -9e15, toExpPos: 9e15 });

/** ISO 4217 currency code. Validated on construction against the configured set. */
export type CurrencyCode = string;

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: CurrencyCode,
    readonly right: CurrencyCode,
  ) {
    super(
      `Cannot combine amounts in different currencies: ${left} and ${right}. ` +
        `Convert explicitly through the currency conversion service first.`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

/**
 * An exact decimal monetary amount in a single currency.
 *
 * ## Why this class exists
 *
 * JavaScript's `number` is an IEEE 754 double and cannot represent 0.1
 * exactly. A tax liability computed through doubles is not defensible: the
 * error is small but it is real, it accumulates, and it is not reproducible
 * across platforms. This system computes money in exact decimal arithmetic,
 * end to end, with no exceptions.
 *
 * ## Why it is a class and not a type alias
 *
 * TypeScript refuses `money + money` on an object type, so the most common way
 * to reintroduce floating point is a compile error rather than a silent defect.
 * A lint rule (`no-restricted-syntax` in the repository ESLint config) closes
 * the remaining gap by rejecting arithmetic operators applied to anything named
 * like an amount.
 *
 * ## Construction
 *
 * Construct from a string or another Money. Construction from `number` is
 * deliberately awkward (`Money.unsafeFromNumber`) because every such call is a
 * place where precision may already have been lost before this class saw the
 * value — typically at a JSON boundary. Those call sites need review, so they
 * are made visible.
 *
 * @example
 * const base = Money.of('125000.00', 'GBP');
 * const rate = Money.rate('0.19');
 * const tax  = base.multiply(rate).round({ scale: 0, mode: RoundingMode.HALF_UP });
 */
export class Money {
  private constructor(
    private readonly amount: Decimal,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  // ---------------------------------------------------------------- factories

  /**
   * Construct from a decimal string. This is the primary constructor.
   *
   * @throws InvalidMoneyError if the value is not a finite decimal number.
   */
  static of(value: string | Money, currency?: CurrencyCode): Money {
    if (value instanceof Money) {
      if (currency !== undefined && currency !== value.currency) {
        throw new CurrencyMismatchError(value.currency, currency);
      }
      return value;
    }
    if (currency === undefined) {
      throw new InvalidMoneyError('Currency is required when constructing Money from a string.');
    }
    Money.assertValidCurrency(currency);

    const trimmed = value.trim();
    if (trimmed === '') {
      throw new InvalidMoneyError('Cannot construct Money from an empty string.');
    }

    let decimal: Decimal;
    try {
      decimal = new Decimal(trimmed);
    } catch {
      throw new InvalidMoneyError(`Not a valid decimal amount: "${value}"`);
    }
    if (!decimal.isFinite()) {
      throw new InvalidMoneyError(`Monetary amount must be finite, received: "${value}"`);
    }
    return new Money(decimal, currency);
  }

  /** Zero in the given currency. */
  static zero(currency: CurrencyCode): Money {
    Money.assertValidCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  /**
   * Construct from a JavaScript number.
   *
   * Named `unsafe` on purpose. By the time a value reaches here as a `number`
   * it may already have lost precision at a JSON or form boundary. Use only at
   * the edges, and prefer changing the caller to carry a string.
   */
  static unsafeFromNumber(value: number, currency: CurrencyCode): Money {
    if (!Number.isFinite(value)) {
      throw new InvalidMoneyError(`Monetary amount must be finite, received: ${value}`);
    }
    return Money.of(String(value), currency);
  }

  /**
   * A dimensionless rate or multiplier (a tax rate, a percentage, a fraction).
   *
   * Rates are not Money — multiplying money by money is meaningless — so they
   * are plain Decimals, but they are constructed through this package so that
   * they get the same precision guarantees.
   */
  static rate(value: string): Decimal {
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new InvalidMoneyError('Cannot construct a rate from an empty string.');
    }
    let decimal: Decimal;
    try {
      decimal = new Decimal(trimmed);
    } catch {
      throw new InvalidMoneyError(`Not a valid rate: "${value}"`);
    }
    if (!decimal.isFinite()) {
      throw new InvalidMoneyError(`Rate must be finite, received: "${value}"`);
    }
    return decimal;
  }

  /** A rate expressed as a percentage: `percent('19')` is the rate 0.19. */
  static percent(value: string): Decimal {
    return Money.rate(value).dividedBy(100);
  }

  // -------------------------------------------------------------- arithmetic

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  /** Multiply by a dimensionless rate. Money times money is not defined. */
  multiply(factor: Decimal | string): Money {
    const decimalFactor = factor instanceof Decimal ? factor : Money.rate(factor);
    return new Money(this.amount.times(decimalFactor), this.currency);
  }

  /**
   * Divide by a dimensionless divisor.
   *
   * The result is held at full working precision and is *not* rounded. Round
   * explicitly when a statutory rule says to.
   */
  divide(divisor: Decimal | string): Money {
    const decimalDivisor = divisor instanceof Decimal ? divisor : Money.rate(divisor);
    if (decimalDivisor.isZero()) {
      throw new InvalidMoneyError('Division by zero in a monetary computation.');
    }
    return new Money(this.amount.dividedBy(decimalDivisor), this.currency);
  }

  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  /**
   * Apply a statutory rounding rule.
   *
   * There is no default: both the scale and the direction must be stated, and
   * both come from `tax_rule_set.rounding_rule`.
   */
  round(rule: RoundingRule): Money {
    if (!Number.isInteger(rule.scale) || rule.scale < 0 || rule.scale > 20) {
      throw new InvalidMoneyError(
        `Rounding scale must be an integer in 0..20, received: ${rule.scale}`,
      );
    }
    return new Money(
      this.amount.toDecimalPlaces(rule.scale, toDecimalJsRounding(rule.mode)),
      this.currency,
    );
  }

  // -------------------------------------------------------------- comparison

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.lessThan(other.amount);
  }

  lessThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.lessThanOrEqualTo(other.amount);
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.greaterThan(other.amount);
  }

  greaterThanOrEqual(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount.greaterThanOrEqualTo(other.amount);
  }

  isZero(): boolean {
    return this.amount.isZero();
  }

  isNegative(): boolean {
    return this.amount.isNegative() && !this.amount.isZero();
  }

  isPositive(): boolean {
    return this.amount.isPositive() && !this.amount.isZero();
  }

  // ------------------------------------------------------------- aggregation

  /**
   * The larger of two amounts.
   *
   * Needed constantly by penalty rules of the form "the greater of a fixed
   * amount and a percentage of the tax due" — a shape the form formula engine
   * cannot express at all, which is part of why computation is server-side.
   */
  static max(first: Money, ...rest: Money[]): Money {
    return rest.reduce((acc, next) => (next.greaterThan(acc) ? next : acc), first);
  }

  /** The smaller of two amounts. Used for capped credits and capped penalties. */
  static min(first: Money, ...rest: Money[]): Money {
    return rest.reduce((acc, next) => (next.lessThan(acc) ? next : acc), first);
  }

  /**
   * Sum a list of amounts.
   *
   * An empty list needs a currency, because zero-of-unknown-currency is not a
   * meaningful value.
   */
  static sum(amounts: readonly Money[], currency: CurrencyCode): Money {
    return amounts.reduce<Money>((acc, next) => acc.add(next), Money.zero(currency));
  }

  /**
   * Split an amount into `parts` shares that sum exactly back to the original.
   *
   * Naive division loses or invents minor units. This distributes the remainder
   * one minor unit at a time across the leading shares, which is the standard
   * apportionment rule and keeps the total exact.
   *
   * @param parts number of shares
   * @param scale minor-unit scale to allocate at (2 for most currencies)
   */
  allocate(parts: number, scale: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new InvalidMoneyError(
        `Allocation requires a positive integer part count, received: ${parts}`,
      );
    }
    const unit = new Decimal(10).toPower(-scale);
    const totalUnits = this.amount.dividedBy(unit).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    const baseUnits = totalUnits.dividedBy(parts).toDecimalPlaces(0, Decimal.ROUND_DOWN);
    let remainder = totalUnits.minus(baseUnits.times(parts));

    const shares: Money[] = [];
    for (let index = 0; index < parts; index += 1) {
      let shareUnits = baseUnits;
      if (remainder.greaterThan(0)) {
        shareUnits = shareUnits.plus(1);
        remainder = remainder.minus(1);
      } else if (remainder.lessThan(0)) {
        shareUnits = shareUnits.minus(1);
        remainder = remainder.plus(1);
      }
      shares.push(new Money(shareUnits.times(unit), this.currency));
    }
    return shares;
  }

  // ------------------------------------------------------------ serialisation

  /**
   * The canonical string form. This is what goes to the database and across
   * the wire — never a JSON number, which would reintroduce double precision
   * at the boundary.
   */
  toString(): string {
    return this.amount.toFixed();
  }

  /** Fixed to a given scale, for display and for database columns. */
  toFixed(scale: number): string {
    return this.amount.toFixed(scale);
  }

  toJSON(): { amount: string; currency: CurrencyCode } {
    return { amount: this.toString(), currency: this.currency };
  }

  /** The value to bind into a `NUMERIC` column. Always a string. */
  toDatabaseValue(): string {
    return this.toString();
  }

  /**
   * Escape hatch to a JavaScript number, for charting and display only.
   *
   * Never use the result in a computation whose output is stored or shown as a
   * legal figure.
   */
  unsafeToNumber(): number {
    return this.amount.toNumber();
  }

  /** The underlying Decimal, for the calculation pipeline's internal steps. */
  toDecimal(): Decimal {
    return this.amount;
  }

  // ------------------------------------------------------------------ guards

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: CurrencyCode): void {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError(
        `Currency must be a three-letter ISO 4217 code, received: "${currency}"`,
      );
    }
  }
}
