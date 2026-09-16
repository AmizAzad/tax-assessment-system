/**
 * Formula tokenizer.
 *
 * Plan reference: V2 section 4.4; ADR-006.
 *
 * The documented formula language is deliberately small: arithmetic with
 * precedence over field references and numeric literals, and nothing else. No
 * function calls, no ternaries, no boolean operators, no property access, no
 * arrays.
 *
 * Unsupported constructs are rejected here with a named error rather than
 * being silently ignored or coerced. That matters: a form author who writes
 * `ROUND(@tax, 0)` must be told the language does not have `ROUND`, not handed
 * a silently wrong number. The rejection is also what makes ADR-006's claim
 * testable -- the limits are asserted, not assumed.
 */

export type TokenType =
  'number' | 'field' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'identifier' | 'comparison';

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  readonly position: number;
}

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
    readonly construct?: string,
  ) {
    super(message);
    this.name = 'FormulaSyntaxError';
  }
}

/** Arithmetic operators the language supports. */
const ARITHMETIC = new Set(['+', '-', '*', '/']);

/** Comparisons, valid only in a formula *validation* rule, never in a value formula. */
const COMPARISONS = ['>=', '<=', '!=', '==', '>', '<'];

/**
 * Constructs that look like they should work but do not.
 *
 * Listed explicitly so the error names the thing the author wrote. Each entry
 * is a documented limitation of the language (plan section 4.4).
 */
const REJECTED_OPERATORS: ReadonlyArray<{ token: string; reason: string }> = [
  { token: '&&', reason: 'boolean AND is not supported' },
  { token: '||', reason: 'boolean OR is not supported' },
  { token: '**', reason: 'exponentiation is not supported' },
  { token: '^', reason: 'exponentiation is not supported' },
  { token: '%', reason: 'modulo is not supported (a percentage field scales automatically)' },
  { token: '?', reason: 'ternary expressions are not supported; use formula selection rules' },
  { token: '[', reason: 'array access is not supported' },
  { token: ']', reason: 'array access is not supported' },
  { token: '{', reason: 'object literals are not supported' },
  { token: '}', reason: 'object literals are not supported' },
];

export interface TokenizeOptions {
  /**
   * Allow comparison operators.
   *
   * True only when tokenizing a formula *validation* rule, which is a single
   * boolean comparison. A value formula that contains one is an error.
   */
  readonly allowComparison?: boolean;
}

export function tokenize(input: string, options: TokenizeOptions = {}): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index]!;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    // Reject the look-alikes before anything else, so the message names the
    // construct rather than complaining about an unexpected character.
    const rejected = REJECTED_OPERATORS.find((entry) => input.startsWith(entry.token, index));
    if (rejected !== undefined) {
      throw new FormulaSyntaxError(
        `'${rejected.token}' is not supported in a formula: ${rejected.reason}`,
        index,
        rejected.token,
      );
    }

    // Comparison, before single-character operators so '>=' is not read as '>'.
    const comparison = COMPARISONS.find((op) => input.startsWith(op, index));
    if (comparison !== undefined) {
      if (options.allowComparison !== true) {
        throw new FormulaSyntaxError(
          `Comparison '${comparison}' is not allowed in a value formula. ` +
            `Comparisons belong in a formula validation rule or a selection rule condition.`,
          index,
          comparison,
        );
      }
      tokens.push({ type: 'comparison', value: comparison, position: index });
      index += comparison.length;
      continue;
    }

    if (ARITHMETIC.has(char)) {
      tokens.push({ type: 'operator', value: char, position: index });
      index += 1;
      continue;
    }

    if (char === '(') {
      tokens.push({ type: 'lparen', value: char, position: index });
      index += 1;
      continue;
    }

    if (char === ')') {
      tokens.push({ type: 'rparen', value: char, position: index });
      index += 1;
      continue;
    }

    if (char === ',') {
      // Only reachable inside a function call, which the parser rejects.
      tokens.push({ type: 'comma', value: char, position: index });
      index += 1;
      continue;
    }

    // Field reference: @jsonKey
    if (char === '@') {
      const match = /^@([A-Za-z_][A-Za-z0-9_.]*)/.exec(input.slice(index));
      if (match === null) {
        throw new FormulaSyntaxError(
          `'@' must be followed by a field key, e.g. @assessedAmount`,
          index,
        );
      }
      tokens.push({ type: 'field', value: match[1]!, position: index });
      index += match[0].length;
      continue;
    }

    // Numeric literal.
    if (/[0-9]/.test(char)) {
      const match = /^[0-9]+(\.[0-9]+)?/.exec(input.slice(index));
      if (match === null) {
        throw new FormulaSyntaxError(`Malformed number`, index);
      }
      tokens.push({ type: 'number', value: match[0], position: index });
      index += match[0].length;
      continue;
    }

    // A bare identifier. Always an error, but the message depends on whether
    // it looks like a function call, because that is the common mistake.
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(index))!;
      const name = match[0];
      const rest = input.slice(index + name.length).trimStart();
      if (rest.startsWith('(')) {
        throw new FormulaSyntaxError(
          `Function '${name}' is not available. The formula language has no functions: ` +
            `no SUM, ROUND, MIN, MAX, IF or VLOOKUP. Values that need them are computed ` +
            `server-side (ADR-006).`,
          index,
          name,
        );
      }
      throw new FormulaSyntaxError(
        `Unknown identifier '${name}'. Reference a field as @${name}.`,
        index,
        name,
      );
    }

    throw new FormulaSyntaxError(`Unexpected character '${char}'`, index);
  }

  return tokens;
}
