import fc from 'fast-check';
import { CurrencyMismatchError, InvalidMoneyError, Money, RoundingMode } from '../src';

const GBP = 'GBP';
const EUR = 'EUR';

describe('Money construction', () => {
  it('preserves decimal values that a double cannot represent', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754. This is the whole reason
    // the class exists, so it is the first test.
    const result = Money.of('0.1', GBP).add(Money.of('0.2', GBP));
    expect(result.toString()).toBe('0.3');
  });

  it('keeps precision far beyond double range', () => {
    const large = Money.of('99999999999999999.9999', GBP);
    expect(large.toString()).toBe('99999999999999999.9999');
  });

  it('accepts negative and zero amounts', () => {
    expect(Money.of('-42.50', GBP).toString()).toBe('-42.5');
    expect(Money.zero(GBP).toString()).toBe('0');
  });

  it('rejects a non-numeric string', () => {
    expect(() => Money.of('not a number', GBP)).toThrow(InvalidMoneyError);
  });

  it('rejects an empty string', () => {
    expect(() => Money.of('   ', GBP)).toThrow(InvalidMoneyError);
  });

  it('rejects infinity', () => {
    expect(() => Money.of('Infinity', GBP)).toThrow(InvalidMoneyError);
  });

  it('rejects a malformed currency code', () => {
    expect(() => Money.of('1.00', 'gbp')).toThrow(InvalidMoneyError);
    expect(() => Money.of('1.00', 'POUNDS')).toThrow(InvalidMoneyError);
  });

  it('requires a currency when constructing from a string', () => {
    expect(() => Money.of('1.00')).toThrow(InvalidMoneyError);
  });

  it('passes through an existing Money unchanged', () => {
    const original = Money.of('10.00', GBP);
    expect(Money.of(original)).toBe(original);
  });

  it('rejects a currency that contradicts an existing Money', () => {
    expect(() => Money.of(Money.of('10.00', GBP), EUR)).toThrow(CurrencyMismatchError);
  });

  it('rejects a non-finite number through the unsafe constructor', () => {
    expect(() => Money.unsafeFromNumber(Number.NaN, GBP)).toThrow(InvalidMoneyError);
    expect(() => Money.unsafeFromNumber(Number.POSITIVE_INFINITY, GBP)).toThrow(InvalidMoneyError);
  });
});

describe('Money rate construction', () => {
  it('builds a rate from a decimal string', () => {
    expect(Money.rate('0.19').toFixed()).toBe('0.19');
  });

  it('builds a rate from a percentage', () => {
    expect(Money.percent('19').toFixed()).toBe('0.19');
  });

  it('accepts a numeric-looking unsafe number source', () => {
    expect(Money.unsafeFromNumber(12.5, GBP).toString()).toBe('12.5');
  });

  it('rejects an empty rate', () => {
    expect(() => Money.rate('  ')).toThrow(InvalidMoneyError);
  });

  it('rejects a malformed rate', () => {
    expect(() => Money.rate('nineteen percent')).toThrow(InvalidMoneyError);
  });

  it('rejects a non-finite rate', () => {
    expect(() => Money.rate('Infinity')).toThrow(InvalidMoneyError);
  });
});

describe('Money currency safety', () => {
  it('refuses to add different currencies', () => {
    expect(() => Money.of('1.00', GBP).add(Money.of('1.00', EUR))).toThrow(CurrencyMismatchError);
  });

  it('refuses to compare different currencies', () => {
    expect(() => Money.of('1.00', GBP).lessThan(Money.of('1.00', EUR))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('treats different currencies as unequal rather than throwing', () => {
    // equals() is a total function: it answers "is this the same amount", and
    // two different currencies are simply not the same amount.
    expect(Money.of('1.00', GBP).equals(Money.of('1.00', EUR))).toBe(false);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    const a = Money.of('1234.56', GBP);
    const b = Money.of('765.44', GBP);
    expect(a.add(b).toString()).toBe('2000');
    expect(a.subtract(b).toString()).toBe('469.12');
  });

  it('multiplies by a rate without premature rounding', () => {
    const base = Money.of('125000.00', GBP);
    const tax = base.multiply(Money.percent('19'));
    expect(tax.toString()).toBe('23750');
  });

  it('holds full precision through division', () => {
    const third = Money.of('100.00', GBP).divide('3');
    // Not rounded: rounding happens only when a statutory rule says so.
    expect(third.toString().startsWith('33.3333333333')).toBe(true);
  });

  it('accepts a rate as either a string or a Decimal', () => {
    const base = Money.of('200.00', GBP);
    expect(base.multiply('0.5').toString()).toBe('100');
    expect(base.multiply(Money.rate('0.5')).toString()).toBe('100');
    expect(base.divide('2').toString()).toBe('100');
    expect(base.divide(Money.rate('2')).toString()).toBe('100');
  });

  it('refuses division by zero', () => {
    expect(() => Money.of('100.00', GBP).divide('0')).toThrow(InvalidMoneyError);
    expect(() => Money.of('100.00', GBP).divide(Money.rate('0'))).toThrow(InvalidMoneyError);
  });

  it('negates and takes absolute value', () => {
    expect(Money.of('-5.00', GBP).abs().toString()).toBe('5');
    expect(Money.of('5.00', GBP).negate().toString()).toBe('-5');
  });

  it('is immutable', () => {
    const original = Money.of('100.00', GBP);
    original.add(Money.of('50.00', GBP));
    expect(original.toString()).toBe('100');
  });
});

describe('Money rounding', () => {
  // The plan requires 100% branch coverage on rounding. Every mode is
  // exercised on a positive and a negative half-way value, because the modes
  // differ precisely there.
  const cases: Array<[RoundingMode, string, string]> = [
    [RoundingMode.HALF_UP, '2.5', '3'],
    [RoundingMode.HALF_UP, '-2.5', '-3'],
    [RoundingMode.HALF_DOWN, '2.5', '2'],
    [RoundingMode.HALF_DOWN, '-2.5', '-2'],
    [RoundingMode.HALF_EVEN, '2.5', '2'],
    [RoundingMode.HALF_EVEN, '3.5', '4'],
    [RoundingMode.HALF_EVEN, '-2.5', '-2'],
    [RoundingMode.UP, '2.1', '3'],
    [RoundingMode.UP, '-2.1', '-3'],
    [RoundingMode.DOWN, '2.9', '2'],
    [RoundingMode.DOWN, '-2.9', '-2'],
    [RoundingMode.CEILING, '2.1', '3'],
    [RoundingMode.CEILING, '-2.9', '-2'],
    [RoundingMode.FLOOR, '2.9', '2'],
    [RoundingMode.FLOOR, '-2.1', '-3'],
  ];

  it.each(cases)('%s rounds %s to %s at scale 0', (mode, input, expected) => {
    expect(Money.of(input, GBP).round({ scale: 0, mode }).toString()).toBe(expected);
  });

  it('rounds to a given scale', () => {
    expect(
      Money.of('1.23456', GBP).round({ scale: 2, mode: RoundingMode.HALF_UP }).toString(),
    ).toBe('1.23');
    expect(
      Money.of('1.23556', GBP).round({ scale: 2, mode: RoundingMode.HALF_UP }).toString(),
    ).toBe('1.24');
  });

  it('rejects a fractional or out-of-range scale', () => {
    expect(() => Money.of('1.00', GBP).round({ scale: 1.5, mode: RoundingMode.HALF_UP })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.of('1.00', GBP).round({ scale: -1, mode: RoundingMode.HALF_UP })).toThrow(
      InvalidMoneyError,
    );
    expect(() => Money.of('1.00', GBP).round({ scale: 99, mode: RoundingMode.HALF_UP })).toThrow(
      InvalidMoneyError,
    );
  });
});

describe('Money comparison', () => {
  const five = Money.of('5.00', GBP);
  const ten = Money.of('10.00', GBP);

  it('orders amounts', () => {
    expect(five.lessThan(ten)).toBe(true);
    expect(ten.lessThan(five)).toBe(false);
    expect(ten.greaterThan(five)).toBe(true);
    expect(five.greaterThan(ten)).toBe(false);
  });

  it('handles inclusive comparisons', () => {
    expect(five.lessThanOrEqual(five)).toBe(true);
    expect(five.lessThanOrEqual(ten)).toBe(true);
    expect(ten.lessThanOrEqual(five)).toBe(false);
    expect(five.greaterThanOrEqual(five)).toBe(true);
    expect(ten.greaterThanOrEqual(five)).toBe(true);
    expect(five.greaterThanOrEqual(ten)).toBe(false);
  });

  it('classifies sign, treating zero as neither positive nor negative', () => {
    const zero = Money.zero(GBP);
    const negative = Money.of('-1.00', GBP);

    expect(zero.isZero()).toBe(true);
    expect(five.isZero()).toBe(false);

    expect(negative.isNegative()).toBe(true);
    expect(zero.isNegative()).toBe(false);
    expect(five.isNegative()).toBe(false);

    expect(five.isPositive()).toBe(true);
    expect(zero.isPositive()).toBe(false);
    expect(negative.isPositive()).toBe(false);
  });

  it('considers equal amounts in the same currency equal', () => {
    expect(Money.of('5.0', GBP).equals(five)).toBe(true);
    expect(ten.equals(five)).toBe(false);
  });
});

describe('Money accessors', () => {
  it('exposes a number for charting only', () => {
    expect(Money.of('1234.56', GBP).unsafeToNumber()).toBeCloseTo(1234.56, 2);
  });

  it('exposes the underlying decimal for pipeline steps', () => {
    expect(Money.of('1234.56', GBP).toDecimal().toFixed()).toBe('1234.56');
  });

  it('reports its currency', () => {
    expect(Money.of('1.00', EUR).currency).toBe(EUR);
  });
});

describe('Money aggregation', () => {
  it('sums a list exactly', () => {
    const amounts = ['0.1', '0.2', '0.3', '0.4'].map((value) => Money.of(value, GBP));
    expect(Money.sum(amounts, GBP).toString()).toBe('1');
  });

  it('sums an empty list to zero', () => {
    expect(Money.sum([], GBP).toString()).toBe('0');
  });

  it('picks the larger amount — the "greater of" penalty shape', () => {
    const fixed = Money.of('500.00', GBP);
    const percentage = Money.of('1200.00', GBP).multiply(Money.percent('5'));
    expect(Money.max(fixed, percentage).toString()).toBe('500');
  });

  it('picks the smaller amount — the capped credit shape', () => {
    expect(Money.min(Money.of('500.00', GBP), Money.of('120.00', GBP)).toString()).toBe('120');
  });

  it('selects correctly whichever side of the comparison wins', () => {
    const low = Money.of('10.00', GBP);
    const high = Money.of('90.00', GBP);
    expect(Money.max(low, high).toString()).toBe('90');
    expect(Money.max(high, low).toString()).toBe('90');
    expect(Money.min(low, high).toString()).toBe('10');
    expect(Money.min(high, low).toString()).toBe('10');
  });

  it('returns the single argument when there is nothing to compare', () => {
    const only = Money.of('42.00', GBP);
    expect(Money.max(only).toString()).toBe('42');
    expect(Money.min(only).toString()).toBe('42');
  });

  it('compares across more than two amounts', () => {
    const amounts = ['30.00', '10.00', '90.00', '50.00'].map((v) => Money.of(v, GBP));
    expect(Money.max(amounts[0]!, ...amounts.slice(1)).toString()).toBe('90');
    expect(Money.min(amounts[0]!, ...amounts.slice(1)).toString()).toBe('10');
  });
});

describe('Money allocation', () => {
  it('splits without losing or inventing minor units', () => {
    const shares = Money.of('100.00', GBP).allocate(3, 2);
    expect(shares.map((share) => share.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(shares, GBP).toFixed(2)).toBe('100.00');
  });

  it('splits a negative amount without losing minor units', () => {
    const shares = Money.of('-100.00', GBP).allocate(3, 2);
    expect(Money.sum(shares, GBP).toFixed(2)).toBe('-100.00');
  });

  it('rejects a non-positive part count', () => {
    expect(() => Money.of('100.00', GBP).allocate(0, 2)).toThrow(InvalidMoneyError);
    expect(() => Money.of('100.00', GBP).allocate(2.5, 2)).toThrow(InvalidMoneyError);
  });
});

describe('Money serialisation', () => {
  it('serialises to a string, never a JSON number', () => {
    const serialised = JSON.parse(JSON.stringify(Money.of('1234.50', GBP)));
    expect(serialised).toEqual({ amount: '1234.5', currency: GBP });
    expect(typeof serialised.amount).toBe('string');
  });

  it('binds to a NUMERIC column as a string', () => {
    expect(typeof Money.of('1.00', GBP).toDatabaseValue()).toBe('string');
  });

  it('formats to a fixed scale for display', () => {
    expect(Money.of('1234.5', GBP).toFixed(2)).toBe('1234.50');
  });
});

describe('Money properties', () => {
  const amount = () =>
    fc
      .tuple(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 99 }),
      )
      .map(([whole, cents]) => Money.of(`${whole}.${String(cents).padStart(2, '0')}`, GBP));

  it('addition is commutative', () => {
    fc.assert(
      fc.property(amount(), amount(), (a, b) => {
        expect(a.add(b).equals(b.add(a))).toBe(true);
      }),
    );
  });

  it('addition is associative — the property doubles break', () => {
    fc.assert(
      fc.property(amount(), amount(), amount(), (a, b, c) => {
        expect(
          a
            .add(b)
            .add(c)
            .equals(a.add(b.add(c))),
        ).toBe(true);
      }),
    );
  });

  it('subtracting then adding returns the original', () => {
    fc.assert(
      fc.property(amount(), amount(), (a, b) => {
        expect(a.subtract(b).add(b).equals(a)).toBe(true);
      }),
    );
  });

  it('allocation always sums back to the original', () => {
    fc.assert(
      fc.property(amount(), fc.integer({ min: 1, max: 12 }), (total, parts) => {
        const shares = total.allocate(parts, 2);
        expect(Money.sum(shares, GBP).toFixed(2)).toBe(total.toFixed(2));
      }),
    );
  });

  it('rounding is idempotent', () => {
    fc.assert(
      fc.property(amount(), (a) => {
        const rule = { scale: 2, mode: RoundingMode.HALF_UP } as const;
        const once = a.round(rule);
        expect(once.round(rule).equals(once)).toBe(true);
      }),
    );
  });

  it('rounding never moves a value by a whole unit', () => {
    fc.assert(
      fc.property(amount(), (a) => {
        const rounded = a.round({ scale: 0, mode: RoundingMode.HALF_UP });
        expect(rounded.subtract(a).abs().lessThanOrEqual(Money.of('1', GBP))).toBe(true);
      }),
    );
  });
});

describe('Money type safety', () => {
  it('cannot be added with the + operator', () => {
    // This is enforced by the compiler: `Money + Money` is TS error 2365.
    // The runtime check below documents that the class has no valueOf() that
    // would let an accidental coercion silently succeed.
    const a = Money.of('1.00', GBP) as unknown as Record<string, unknown>;
    expect(a['valueOf']).toBe(Object.prototype.valueOf);
  });
});
