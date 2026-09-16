import {
  FormulaEvaluationError,
  FormulaSyntaxError,
  contextFromValues,
  evaluateFormula,
  evaluateValidation,
  findCircularReferences,
  parseFormula,
  referencedFields,
} from '../src';

const ctx = (
  values: Record<string, unknown>,
  meta: Record<string, { currency?: string; isPercentage?: boolean }> = {},
) => contextFromValues(values, meta);

describe('formula - supported arithmetic', () => {
  it('evaluates the four operators with correct precedence', () => {
    const context = ctx({ a: 10, b: 4, c: 2 });
    expect(evaluateFormula('@a + @b * @c', context)).toEqual({ kind: 'number', value: 18 });
    expect(evaluateFormula('(@a + @b) * @c', context)).toEqual({ kind: 'number', value: 28 });
    expect(evaluateFormula('@a - @b / @c', context)).toEqual({ kind: 'number', value: 8 });
  });

  it('handles unary minus and nested parentheses', () => {
    const context = ctx({ a: 5 });
    expect(evaluateFormula('-@a', context)).toEqual({ kind: 'number', value: -5 });
    expect(evaluateFormula('-(@a - 10)', context)).toEqual({ kind: 'number', value: 5 });
  });

  it('computes the difference formula from the adjustment form', () => {
    // TA-06: differenceAmount = assessedAmount - declaredAmount
    const context = ctx({ assessedAmount: 125000, declaredAmount: 100000 });
    expect(evaluateFormula('@assessedAmount - @declaredAmount', context)).toEqual({
      kind: 'number',
      value: 25000,
    });
  });

  it('treats an empty field as zero so a half-filled form still totals', () => {
    const context = ctx({ a: 100, b: null });
    expect(evaluateFormula('@a + @b', context)).toEqual({ kind: 'number', value: 100 });
  });

  it('scales a percentage field automatically', () => {
    const context = ctx({ base: 1000, rate: 19 }, { rate: { isPercentage: true } });
    expect(evaluateFormula('@base * @rate', context)).toEqual({ kind: 'number', value: 190 });
  });

  it('propagates a currency when operands agree', () => {
    const context = ctx({ a: 100, b: 50 }, { a: { currency: 'GBP' }, b: { currency: 'GBP' } });
    expect(evaluateFormula('@a + @b', context)).toEqual({
      kind: 'currency',
      value: 150,
      currency: 'GBP',
    });
  });

  it('rejects mixed currencies', () => {
    const context = ctx({ a: 100, b: 50 }, { a: { currency: 'GBP' }, b: { currency: 'EUR' } });
    expect(() => evaluateFormula('@a + @b', context)).toThrow(FormulaEvaluationError);
  });

  it('rejects division by zero', () => {
    expect(() => evaluateFormula('@a / @b', ctx({ a: 1, b: 0 }))).toThrow(/Division by zero/);
  });

  it('names an unknown field rather than silently evaluating to zero', () => {
    expect(() => evaluateFormula('@nope + 1', ctx({ a: 1 }))).toThrow(/unknown field/i);
  });
});

describe('formula - date arithmetic', () => {
  const may1 = new Date('2026-05-01T00:00:00Z');
  const may31 = new Date('2026-05-31T00:00:00Z');

  it('subtracts two dates to whole days', () => {
    const result = evaluateFormula('@end - @start', ctx({ start: may1, end: may31 }));
    expect(result).toEqual({ kind: 'number', value: 30 });
  });

  it('adds days to a date', () => {
    const result = evaluateFormula('@start + 30', ctx({ start: may1 }));
    expect(result.kind).toBe('date');
    expect((result as { value: Date }).value.toISOString()).toBe(may31.toISOString());
  });

  it('parses a date string field', () => {
    const result = evaluateFormula(
      '@end - @start',
      ctx({ start: '2026-05-01', end: '2026-05-31' }),
    );
    expect(result).toEqual({ kind: 'number', value: 30 });
  });

  it('refuses to multiply a date', () => {
    expect(() => evaluateFormula('@start * 2', ctx({ start: may1 }))).toThrow(
      FormulaEvaluationError,
    );
  });
});

/**
 * These are the tests that make ADR-006 evidence rather than assertion.
 *
 * The formula language has no functions. Anyone proposing to compute tax in a
 * form meets this suite first.
 */
describe('formula - documented limits', () => {
  const unsupportedFunctions = ['SUM', 'AVERAGE', 'COUNT', 'ROUND', 'MIN', 'MAX', 'IF', 'VLOOKUP'];

  it.each(unsupportedFunctions)('rejects %s() and says why', (fn) => {
    expect(() => parseFormula(`${fn}(@a, @b)`)).toThrow(FormulaSyntaxError);
    expect(() => parseFormula(`${fn}(@a, @b)`)).toThrow(/no functions/i);
  });

  const unsupportedOperators: Array<[string, RegExp]> = [
    ['@a && @b', /boolean AND/],
    ['@a || @b', /boolean OR/],
    ['@a ** 2', /exponentiation/],
    ['@a ^ 2', /exponentiation/],
    ['@a % 2', /modulo/],
    ['@a ? @b : @c', /ternary/],
    ['@a[0]', /array access/],
    ['{ a: 1 }', /object literals/],
  ];

  it.each(unsupportedOperators)('rejects %s', (expression, reason) => {
    expect(() => parseFormula(expression)).toThrow(reason);
  });

  it('rejects a comparison in a value formula', () => {
    // Comparisons belong in a validation rule, not in a computed value.
    expect(() => parseFormula('@a > @b')).toThrow(/not allowed in a value formula/);
  });

  it('rejects property access', () => {
    expect(() => parseFormula('a.b')).toThrow(FormulaSyntaxError);
  });

  it('rejects a bare identifier and suggests the field syntax', () => {
    expect(() => parseFormula('assessedAmount')).toThrow(/Reference a field as @assessedAmount/);
  });

  it('rejects an unbalanced parenthesis', () => {
    expect(() => parseFormula('(@a + @b')).toThrow(/closing parenthesis/);
  });

  it('rejects trailing junk', () => {
    expect(() => parseFormula('@a + @b )')).toThrow(FormulaSyntaxError);
  });

  it('rejects an empty formula', () => {
    expect(() => parseFormula('   ')).toThrow(/empty/);
  });

  it('IS floating point, which is exactly why it is not authoritative', () => {
    // 0.1 + 0.2 !== 0.3 here. The server computes the legal figure in exact
    // decimal (ADR-007); this engine exists for on-screen feedback only.
    const result = evaluateFormula('@a + @b', ctx({ a: 0.1, b: 0.2 }));
    expect((result as { value: number }).value).not.toBe(0.3);
    expect((result as { value: number }).value).toBeCloseTo(0.3, 10);
  });
});

describe('formula - validation rules', () => {
  it('evaluates a comparison to a boolean', () => {
    expect(evaluateValidation('@assessedAmount >= 0', ctx({ assessedAmount: 5 }))).toBe(true);
    expect(evaluateValidation('@assessedAmount >= 0', ctx({ assessedAmount: -1 }))).toBe(false);
  });

  it('supports every comparison operator', () => {
    const context = ctx({ a: 5, b: 10 });
    expect(evaluateValidation('@a < @b', context)).toBe(true);
    expect(evaluateValidation('@a > @b', context)).toBe(false);
    expect(evaluateValidation('@a <= 5', context)).toBe(true);
    expect(evaluateValidation('@a >= 6', context)).toBe(false);
    expect(evaluateValidation('@a == 5', context)).toBe(true);
    expect(evaluateValidation('@a != 5', context)).toBe(false);
  });

  it('evaluates the TA-09 cross-check shape', () => {
    // netPayableOrRefundable == totalPayable - amountAlreadyPaid
    const context = ctx({ net: 400, total: 1000, paid: 600 });
    expect(evaluateValidation('@net == @total - @paid', context)).toBe(true);
  });

  it('rejects a validation rule that is not a comparison', () => {
    expect(() => evaluateValidation('@a + @b', ctx({ a: 1, b: 2 }))).toThrow(/comparison/);
  });

  it('refuses to compare a date with a number', () => {
    expect(() => evaluateValidation('@d > @n', ctx({ d: new Date('2026-01-01'), n: 5 }))).toThrow(
      FormulaEvaluationError,
    );
  });
});

describe('formula - dependency analysis', () => {
  it('lists referenced fields', () => {
    expect([...referencedFields(parseFormula('@a + @b * (@c - @a)'))].sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('finds no cycle in an acyclic set', () => {
    expect(findCircularReferences({ total: '@a + @b', grand: '@total * 2' })).toEqual([]);
  });

  it('detects a direct cycle', () => {
    expect(findCircularReferences({ a: '@b', b: '@a' })).toEqual(['a', 'b']);
  });

  it('detects an indirect cycle', () => {
    expect(findCircularReferences({ a: '@b', b: '@c', c: '@a' })).toEqual(['a', 'b', 'c']);
  });

  it('detects a self-reference', () => {
    expect(findCircularReferences({ a: '@a + 1' })).toEqual(['a']);
  });

  it('leaves acyclic members out of the reported cycle', () => {
    const cycle = findCircularReferences({ a: '@b', b: '@a', safe: '@a + 1' });
    expect(cycle).toEqual(['a', 'b']);
  });
});
