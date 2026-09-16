import { formatAmount, humanise, isNegativeAmount, statusTone } from './domain';

/**
 * The only logic the browser is allowed to have about money.
 *
 * Plan reference: ADR-006, ADR-007.
 *
 * `formatAmount` groups digits for display. Everything it must *not* do is
 * what these tests are really about: it must not round, must not go through a
 * JavaScript number, and must not lose a digit of a figure larger than a
 * double can hold. A register that quietly altered an amount on the way to the
 * screen could not be reconciled against the notice quoting it.
 */
describe('formatAmount', () => {
  it('groups thousands', () => {
    expect(formatAmount('1234567.89')).toBe('1,234,567.89');
  });

  it('keeps two decimal places', () => {
    expect(formatAmount('100')).toBe('100.00');
    expect(formatAmount('100.5')).toBe('100.50');
  });

  it('truncates the stored four decimals to two without rounding', () => {
    // The database keeps NUMERIC(20,4). Display shows two. Rounding here
    // would disagree with the server's own rounding, which is applied once,
    // at the taxable-base step, with an explicit rule.
    expect(formatAmount('16742.0000')).toBe('16,742.00');
    expect(formatAmount('2842.2399')).toBe('2,842.23');
  });

  it('handles negatives, which are refunds', () => {
    expect(formatAmount('-4267.00')).toBe('-4,267.00');
    expect(isNegativeAmount('-4267.00')).toBe(true);
    expect(isNegativeAmount('4267.00')).toBe(false);
  });

  it('does not lose precision on a figure larger than a double holds exactly', () => {
    // 9007199254740993 is 2^53 + 1: `Number()` cannot represent it, so any
    // implementation that parsed would return ...992 here.
    expect(formatAmount('9007199254740993.00')).toBe('9,007,199,254,740,993.00');
  });

  it('shows an em dash for an absent value rather than zero', () => {
    // "No calculation yet" and "a calculation of nil" are different facts.
    expect(formatAmount(null)).toBe('—');
    expect(formatAmount(undefined)).toBe('—');
    expect(formatAmount('')).toBe('—');
  });

  it('formats zero as a figure, not as absent', () => {
    expect(formatAmount('0')).toBe('0.00');
    expect(formatAmount('0.0000')).toBe('0.00');
  });
});

describe('statusTone', () => {
  it('marks concluded statuses as done', () => {
    expect(statusTone('CLOSED')).toBe('done');
    expect(statusTone('SETTLED')).toBe('done');
  });

  it('marks anything waiting on somebody as waiting', () => {
    expect(statusTone('PENDING_APPROVAL')).toBe('waiting');
    expect(statusTone('AWAITING_TAXPAYER_RESPONSE')).toBe('waiting');
  });

  it('marks refused and barred statuses as stopped', () => {
    expect(statusTone('CANCELLED')).toBe('stopped');
    expect(statusTone('TIME_BARRED')).toBe('stopped');
  });

  it('falls back to neutral rather than guessing', () => {
    // A status nobody has classified should look unremarkable, not alarming.
    expect(statusTone('SOME_FUTURE_STATUS')).toBe('neutral');
  });
});

describe('humanise', () => {
  it('turns a code into a sentence', () => {
    expect(humanise('IN_PREPARATION')).toBe('In preparation');
  });

  it('leaves an absent value visible', () => {
    expect(humanise(null)).toBe('—');
  });
});
