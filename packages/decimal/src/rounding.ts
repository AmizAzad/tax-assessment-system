import Decimal from 'decimal.js';

/**
 * Statutory rounding modes.
 *
 * Tax law does not agree on rounding. Some jurisdictions round half away from
 * zero, some round half to even ("banker's rounding") to avoid systematic bias,
 * some always round the taxpayer's liability down and refunds up. The mode is
 * therefore configuration (`tax_rule_set.rounding_rule`), never a default.
 *
 * There is deliberately no default value anywhere in this package: every call
 * site must state which rule it is applying, so that a reviewer can check it
 * against the statute.
 */
export enum RoundingMode {
  /** Round half away from zero. 2.5 -> 3, -2.5 -> -3. The common statutory default. */
  HALF_UP = 'HALF_UP',
  /** Round half towards zero. 2.5 -> 2, -2.5 -> -2. */
  HALF_DOWN = 'HALF_DOWN',
  /** Round half to the nearest even digit. 2.5 -> 2, 3.5 -> 4. Avoids cumulative bias. */
  HALF_EVEN = 'HALF_EVEN',
  /** Always away from zero. 2.1 -> 3, -2.1 -> -3. */
  UP = 'UP',
  /** Always towards zero (truncate). 2.9 -> 2, -2.9 -> -2. */
  DOWN = 'DOWN',
  /** Always towards positive infinity. 2.1 -> 3, -2.9 -> -2. */
  CEILING = 'CEILING',
  /** Always towards negative infinity. 2.9 -> 2, -2.1 -> -3. */
  FLOOR = 'FLOOR',
}

const DECIMAL_JS_ROUNDING: Record<RoundingMode, Decimal.Rounding> = {
  [RoundingMode.HALF_UP]: Decimal.ROUND_HALF_UP,
  [RoundingMode.HALF_DOWN]: Decimal.ROUND_HALF_DOWN,
  [RoundingMode.HALF_EVEN]: Decimal.ROUND_HALF_EVEN,
  [RoundingMode.UP]: Decimal.ROUND_UP,
  [RoundingMode.DOWN]: Decimal.ROUND_DOWN,
  [RoundingMode.CEILING]: Decimal.ROUND_CEIL,
  [RoundingMode.FLOOR]: Decimal.ROUND_FLOOR,
};

export function toDecimalJsRounding(mode: RoundingMode): Decimal.Rounding {
  const mapped = DECIMAL_JS_ROUNDING[mode];
  if (mapped === undefined) {
    throw new RangeError(`Unknown rounding mode: ${String(mode)}`);
  }
  return mapped;
}

/**
 * A rounding instruction: how many decimal places, and in which direction.
 *
 * `scale` is the number of decimal places to keep. Rounding to whole currency
 * units (common for final tax liability) is scale 0.
 */
export interface RoundingRule {
  readonly scale: number;
  readonly mode: RoundingMode;
}
