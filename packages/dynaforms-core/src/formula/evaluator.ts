import { parseComparison, parseFormula, referencedFields, type FormulaNode } from './parser';

/**
 * Formula evaluator.
 *
 * Plan reference: V2 section 4.4; ADR-006.
 *
 * ## This is deliberately floating point
 *
 * The evaluator computes in JavaScript `number`, matching the documented
 * upstream behaviour. That is not an oversight and it is not something to
 * "fix" here: it is precisely why a formula result is never the legal figure.
 * A tax liability is computed server-side in exact decimal, versioned and
 * traced (ADR-006 and ADR-007).
 *
 * What this engine is for: immediate on-screen feedback while an officer
 * types, and cross-checks that surface a disagreement between what the browser
 * shows and what the server computed. Both are useful. Neither is authoritative.
 *
 * There is a test that asserts the imprecision exists, so that anyone tempted
 * to promote a formula result to a stored figure meets the evidence first.
 */

export type FormulaValueKind = 'number' | 'date' | 'currency';

export type FormulaValue =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'date'; readonly value: Date }
  | { readonly kind: 'currency'; readonly value: number; readonly currency: string };

export class FormulaEvaluationError extends Error {
  constructor(
    message: string,
    // Named `reason` rather than `cause`: Error.cause exists in ES2022 and
    // shadowing it with a different meaning is a trap for the next reader.
    readonly reason?:
      | 'UNKNOWN_FIELD'
      | 'CIRCULAR_REFERENCE'
      | 'MIXED_CURRENCY'
      | 'TYPE_MISMATCH'
      | 'DIVIDE_BY_ZERO',
  ) {
    super(message);
    this.name = 'FormulaEvaluationError';
  }
}

/** What a formula can read. */
export interface FormulaContext {
  /**
   * Resolve a field's value.
   *
   * Return `undefined` for a field that exists but is empty -- it is treated
   * as zero, matching the documented behaviour. Throw for a field that does
   * not exist, so a typo in a formula surfaces rather than silently
   * evaluating to zero.
   */
  readonly resolve: (key: string) => FormulaValue | undefined;
}

const MILLISECONDS_PER_DAY = 86_400_000;

/** Build a context over a plain value map and the elements that describe them. */
export function contextFromValues(
  values: Readonly<Record<string, unknown>>,
  meta: Readonly<Record<string, { currency?: string; isPercentage?: boolean }>> = {},
): FormulaContext {
  return {
    resolve(key: string): FormulaValue | undefined {
      if (!(key in values)) {
        throw new FormulaEvaluationError(
          `Formula references unknown field '@${key}'`,
          'UNKNOWN_FIELD',
        );
      }
      const raw = values[key];
      if (raw === null || raw === undefined || raw === '') {
        return undefined;
      }

      if (raw instanceof Date) {
        return { kind: 'date', value: raw };
      }

      const fieldMeta = meta[key];
      const numeric = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isNaN(numeric)) {
        // A date string is the only non-numeric a formula can use.
        const parsed = Date.parse(String(raw));
        if (!Number.isNaN(parsed)) {
          return { kind: 'date', value: new Date(parsed) };
        }
        throw new FormulaEvaluationError(
          `Field '@${key}' holds a value that is neither a number nor a date`,
          'TYPE_MISMATCH',
        );
      }

      // A percentage field contributes its fraction, so `@rate * @base` works
      // without the author writing `/100`.
      const value = fieldMeta?.isPercentage === true ? numeric / 100 : numeric;

      return fieldMeta?.currency !== undefined
        ? { kind: 'currency', value, currency: fieldMeta.currency }
        : { kind: 'number', value };
    },
  };
}

function asNumeric(value: FormulaValue): number {
  if (value.kind === 'date') {
    throw new FormulaEvaluationError(
      'A date cannot be used directly in arithmetic; subtract two dates to get days, ' +
        'or add a number of days to a date',
      'TYPE_MISMATCH',
    );
  }
  return value.value;
}

function combineCurrency(left: FormulaValue, right: FormulaValue): string | undefined {
  const leftCurrency = left.kind === 'currency' ? left.currency : undefined;
  const rightCurrency = right.kind === 'currency' ? right.currency : undefined;
  if (leftCurrency !== undefined && rightCurrency !== undefined) {
    if (leftCurrency !== rightCurrency) {
      throw new FormulaEvaluationError(
        `Cannot combine ${leftCurrency} and ${rightCurrency} in one formula`,
        'MIXED_CURRENCY',
      );
    }
    return leftCurrency;
  }
  return leftCurrency ?? rightCurrency;
}

function numeric(value: number, currency: string | undefined): FormulaValue {
  return currency === undefined ? { kind: 'number', value } : { kind: 'currency', value, currency };
}

function evaluateNode(node: FormulaNode, context: FormulaContext): FormulaValue {
  switch (node.kind) {
    case 'number':
      return { kind: 'number', value: node.value };

    case 'field': {
      // An empty field contributes zero rather than blocking the formula:
      // a half-filled form should still show a running total.
      return context.resolve(node.key) ?? { kind: 'number', value: 0 };
    }

    case 'negate': {
      const operand = evaluateNode(node.operand, context);
      const currency = operand.kind === 'currency' ? operand.currency : undefined;
      return numeric(-asNumeric(operand), currency);
    }

    case 'binary': {
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);

      // --- date arithmetic ---
      if (left.kind === 'date' && right.kind === 'date') {
        if (node.operator !== '-') {
          throw new FormulaEvaluationError(
            'Two dates can only be subtracted, giving a number of days',
            'TYPE_MISMATCH',
          );
        }
        const days = (left.value.getTime() - right.value.getTime()) / MILLISECONDS_PER_DAY;
        return { kind: 'number', value: days };
      }

      if (right.kind === 'date') {
        // date on the right, number on the left: `5 + @date` is not meaningful.
        throw new FormulaEvaluationError(
          'Days must be added to a date, not a date to a number',
          'TYPE_MISMATCH',
        );
      }

      if (left.kind === 'date') {
        if (node.operator !== '+' && node.operator !== '-') {
          throw new FormulaEvaluationError(
            'A date can only have days added or subtracted',
            'TYPE_MISMATCH',
          );
        }
        const days = asNumeric(right);
        const shifted = new Date(
          left.value.getTime() + (node.operator === '+' ? days : -days) * MILLISECONDS_PER_DAY,
        );
        return { kind: 'date', value: shifted };
      }

      // --- numeric arithmetic ---
      const currency = combineCurrency(left, right);
      const a = asNumeric(left);
      const b = asNumeric(right);

      switch (node.operator) {
        case '+':
          return numeric(a + b, currency);
        case '-':
          return numeric(a - b, currency);
        case '*':
          // Multiplying two currency amounts is meaningless; the currency of
          // the product is whichever side carried one.
          return numeric(a * b, currency);
        case '/':
          if (b === 0) {
            throw new FormulaEvaluationError('Division by zero', 'DIVIDE_BY_ZERO');
          }
          return numeric(a / b, currency);
      }
      break;
    }

    case 'comparison':
      throw new FormulaEvaluationError(
        'A comparison cannot produce a value; use evaluateValidation instead',
        'TYPE_MISMATCH',
      );
  }

  throw new FormulaEvaluationError('Unreachable formula node');
}

/** Evaluate a value formula. */
export function evaluateFormula(expression: string, context: FormulaContext): FormulaValue {
  return evaluateNode(parseFormula(expression), context);
}

/** Evaluate a formula validation rule to a boolean. */
export function evaluateValidation(expression: string, context: FormulaContext): boolean {
  const node = parseComparison(expression);
  if (node.kind !== 'comparison') {
    throw new FormulaEvaluationError('Validation formula must be a comparison');
  }

  const left = evaluateNode(node.left, context);
  const right = evaluateNode(node.right, context);

  if ((left.kind === 'date') !== (right.kind === 'date')) {
    throw new FormulaEvaluationError('Cannot compare a date with a number', 'TYPE_MISMATCH');
  }

  const a = left.kind === 'date' ? left.value.getTime() : asNumeric(left);
  const b = right.kind === 'date' ? right.value.getTime() : asNumeric(right);

  if (left.kind !== 'date' && right.kind !== 'date') {
    combineCurrency(left, right);
  }

  switch (node.operator) {
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    case '==':
      return a === b;
    case '!=':
      return a !== b;
  }
}

/**
 * Detect circular references across a set of formula fields.
 *
 * Upstream forbids cycles between formula widgets. Without this check a cycle
 * is an infinite loop at render time; with it, the form fails to publish.
 *
 * @param formulas jsonKey -> formula expression
 * @returns the keys involved in a cycle, empty if there is none
 */
export function findCircularReferences(
  formulas: Readonly<Record<string, string>>,
): readonly string[] {
  const dependencies = new Map<string, Set<string>>();
  for (const [key, expression] of Object.entries(formulas)) {
    dependencies.set(key, referencedFields(parseFormula(expression)));
  }

  const inCycle = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (key: string, stack: string[]): void => {
    const current = state.get(key);
    if (current === 'done') return;
    if (current === 'visiting') {
      // Everything from the first sighting of `key` onward is in the cycle.
      const start = stack.indexOf(key);
      for (const member of stack.slice(start)) {
        inCycle.add(member);
      }
      return;
    }

    state.set(key, 'visiting');
    stack.push(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (dependencies.has(dependency)) {
        visit(dependency, stack);
      }
    }
    stack.pop();
    state.set(key, 'done');
  };

  for (const key of dependencies.keys()) {
    visit(key, []);
  }

  return [...inCycle].sort();
}
