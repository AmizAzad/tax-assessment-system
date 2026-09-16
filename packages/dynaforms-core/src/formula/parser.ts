import { FormulaSyntaxError, type Token, tokenize } from './tokenizer';

/**
 * Formula parser.
 *
 * Plan reference: V2 section 4.4.
 *
 * Precedence climbing over a two-level grammar:
 *
 *   comparison := expression (comparison-op expression)?     [validation rules only]
 *   expression := term (('+' | '-') term)*
 *   term       := factor (('*' | '/') factor)*
 *   factor     := '-'? (number | field | '(' expression ')')
 *
 * That is the whole language. There is no call production, which is why a
 * function call cannot parse even if someone bypasses the tokenizer check.
 */

export type FormulaNode =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'field'; readonly key: string }
  | { readonly kind: 'negate'; readonly operand: FormulaNode }
  | {
      readonly kind: 'binary';
      readonly operator: '+' | '-' | '*' | '/';
      readonly left: FormulaNode;
      readonly right: FormulaNode;
    }
  | {
      readonly kind: 'comparison';
      readonly operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
      readonly left: FormulaNode;
      readonly right: FormulaNode;
    };

class Parser {
  private position = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private next(): Token | undefined {
    return this.tokens[this.position++];
  }

  parseComparison(): FormulaNode {
    const left = this.parseExpression();
    const token = this.peek();
    if (token?.type === 'comparison') {
      this.next();
      const right = this.parseExpression();
      return {
        kind: 'comparison',
        operator: token.value as '>' | '<' | '>=' | '<=' | '==' | '!=',
        left,
        right,
      };
    }
    return left;
  }

  parseExpression(): FormulaNode {
    let left = this.parseTerm();
    for (;;) {
      const token = this.peek();
      if (token?.type === 'operator' && (token.value === '+' || token.value === '-')) {
        this.next();
        const right = this.parseTerm();
        left = { kind: 'binary', operator: token.value, left, right };
      } else {
        return left;
      }
    }
  }

  private parseTerm(): FormulaNode {
    let left = this.parseFactor();
    for (;;) {
      const token = this.peek();
      if (token?.type === 'operator' && (token.value === '*' || token.value === '/')) {
        this.next();
        const right = this.parseFactor();
        left = { kind: 'binary', operator: token.value, left, right };
      } else {
        return left;
      }
    }
  }

  private parseFactor(): FormulaNode {
    const token = this.next();
    if (token === undefined) {
      throw new FormulaSyntaxError('Unexpected end of formula', this.endPosition());
    }

    if (token.type === 'operator' && token.value === '-') {
      return { kind: 'negate', operand: this.parseFactor() };
    }

    if (token.type === 'operator' && token.value === '+') {
      // Unary plus is a no-op but is accepted so `+5` is not a syntax error.
      return this.parseFactor();
    }

    if (token.type === 'number') {
      return { kind: 'number', value: Number(token.value) };
    }

    if (token.type === 'field') {
      return { kind: 'field', key: token.value };
    }

    if (token.type === 'lparen') {
      const inner = this.parseExpression();
      const closing = this.next();
      if (closing?.type !== 'rparen') {
        throw new FormulaSyntaxError('Missing closing parenthesis', token.position);
      }
      return inner;
    }

    if (token.type === 'comma') {
      throw new FormulaSyntaxError(
        'Commas are only meaningful in function arguments, and the formula language has no functions',
        token.position,
      );
    }

    throw new FormulaSyntaxError(`Unexpected '${token.value}'`, token.position);
  }

  ensureConsumed(): void {
    const token = this.peek();
    if (token !== undefined) {
      throw new FormulaSyntaxError(
        `Unexpected '${token.value}' after end of expression`,
        token.position,
      );
    }
  }

  private endPosition(): number {
    const last = this.tokens[this.tokens.length - 1];
    return last === undefined ? 0 : last.position + last.value.length;
  }
}

/** Parse a value formula. Comparisons are rejected. */
export function parseFormula(input: string): FormulaNode {
  const tokens = tokenize(input);
  if (tokens.length === 0) {
    throw new FormulaSyntaxError('Formula is empty', 0);
  }
  const parser = new Parser(tokens);
  const node = parser.parseExpression();
  parser.ensureConsumed();
  return node;
}

/** Parse a formula validation rule: one boolean comparison. */
export function parseComparison(input: string): FormulaNode {
  const tokens = tokenize(input, { allowComparison: true });
  if (tokens.length === 0) {
    throw new FormulaSyntaxError('Validation formula is empty', 0);
  }
  const parser = new Parser(tokens);
  const node = parser.parseComparison();
  parser.ensureConsumed();
  if (node.kind !== 'comparison') {
    throw new FormulaSyntaxError(
      'A formula validation rule must be a comparison, e.g. @assessedAmount >= 0',
      0,
    );
  }
  return node;
}

/** Every field key a formula reads. Used for dependency ordering and cycle detection. */
export function referencedFields(node: FormulaNode): Set<string> {
  const keys = new Set<string>();
  const visit = (current: FormulaNode): void => {
    switch (current.kind) {
      case 'field':
        keys.add(current.key);
        break;
      case 'negate':
        visit(current.operand);
        break;
      case 'binary':
      case 'comparison':
        visit(current.left);
        visit(current.right);
        break;
      case 'number':
        break;
    }
  };
  visit(node);
  return keys;
}
