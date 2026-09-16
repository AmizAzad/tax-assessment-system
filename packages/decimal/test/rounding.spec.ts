import Decimal from 'decimal.js';
import { RoundingMode, toDecimalJsRounding } from '../src';

describe('toDecimalJsRounding', () => {
  it('maps every declared mode to a decimal.js rounding constant', () => {
    // If a mode is added to the enum without a mapping, this fails rather than
    // throwing at runtime inside a tax computation.
    for (const mode of Object.values(RoundingMode)) {
      expect(typeof toDecimalJsRounding(mode)).toBe('number');
    }
  });

  it('maps modes to the expected decimal.js constants', () => {
    expect(toDecimalJsRounding(RoundingMode.HALF_UP)).toBe(Decimal.ROUND_HALF_UP);
    expect(toDecimalJsRounding(RoundingMode.HALF_DOWN)).toBe(Decimal.ROUND_HALF_DOWN);
    expect(toDecimalJsRounding(RoundingMode.HALF_EVEN)).toBe(Decimal.ROUND_HALF_EVEN);
    expect(toDecimalJsRounding(RoundingMode.UP)).toBe(Decimal.ROUND_UP);
    expect(toDecimalJsRounding(RoundingMode.DOWN)).toBe(Decimal.ROUND_DOWN);
    expect(toDecimalJsRounding(RoundingMode.CEILING)).toBe(Decimal.ROUND_CEIL);
    expect(toDecimalJsRounding(RoundingMode.FLOOR)).toBe(Decimal.ROUND_FLOOR);
  });

  it('rejects an unknown mode rather than defaulting', () => {
    // A rule set loaded from configuration could carry a mode this build does
    // not know. Failing loudly is correct: silently defaulting to HALF_UP would
    // compute a wrong liability.
    expect(() => toDecimalJsRounding('BANKERS' as RoundingMode)).toThrow(RangeError);
  });
});
