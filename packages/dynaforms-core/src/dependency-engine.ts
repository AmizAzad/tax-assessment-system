import {
  flattenElements,
  holdsValue,
  type DependencyCondition,
  type DependencyRule,
  type FormDefinition,
  type FormValues,
  type ResolvedFieldState,
  type ResolvedFormState,
} from './types';

/**
 * The dependency engine.
 *
 * Plan reference: V2 section 4.1; ADR-005.
 *
 * Resolves, for every field, whether it is visible, whether it is required,
 * and what option values remain selectable, given the current form values.
 *
 * ## Why this runs on the server too
 *
 * A conditionally-required field is a *control*, not a presentation choice.
 * "Narrative is mandatory when the adjustment difference is non-zero" is a
 * rule about what constitutes a valid assessment, and a caller who posts
 * straight to the API must be held to it. So the server resolves the same
 * state from the same code, and validation runs against the resolved state
 * rather than against the authored baseline.
 *
 * ## Resolution order
 *
 * When no rule matches, the authored baseline is restored -- a field that is
 * required in the definition is required again once the rule that relaxed it
 * stops matching. This matches the documented upstream behaviour and is what
 * makes a rule set reversible as the user edits.
 */

export function evaluateCondition(condition: DependencyCondition, values: FormValues): boolean {
  const actual = values[condition.field];
  const expected = condition.value;

  switch (condition.operator) {
    case 'empty':
      return isEmpty(actual);
    case 'notEmpty':
      return !isEmpty(actual);
    case 'eq':
      return looseEquals(actual, expected);
    case 'neq':
      return !looseEquals(actual, expected);
    case 'contains':
      return contains(actual, expected);
    case 'lt':
    case 'gt':
    case 'lte':
    case 'gte': {
      const a = toComparable(actual);
      const b = toComparable(expected);
      // A comparison against an absent or non-numeric value is false rather
      // than an error: a half-filled form must not break the renderer.
      if (a === undefined || b === undefined) return false;
      switch (condition.operator) {
        case 'lt':
          return a < b;
        case 'gt':
          return a > b;
        case 'lte':
          return a <= b;
        case 'gte':
          return a >= b;
      }
    }
  }
  return false;
}

function ruleMatches(rule: DependencyRule, values: FormValues): boolean {
  if (rule.conditions.length === 0) return false;
  const combinator = rule.combinator ?? 'AND';
  return combinator === 'AND'
    ? rule.conditions.every((condition) => evaluateCondition(condition, values))
    : rule.conditions.some((condition) => evaluateCondition(condition, values));
}

/**
 * Resolve the state of every field.
 *
 * Deterministic and side-effect free: the same definition and values always
 * produce the same state, which is what lets the server and the browser agree.
 */
export function resolveFormState(
  definition: FormDefinition,
  values: FormValues,
): ResolvedFormState {
  const state = new Map<string, ResolvedFieldState>();

  for (const element of flattenElements(definition)) {
    if (element.jsonKey === '') continue;

    // The authored baseline, restored whenever no rule matches.
    let visible = element.hidden !== true;
    let required = element.required === true;
    let minLength = element.minLength;
    let maxLength = element.maxLength;
    let allowedValues: readonly string[] | undefined;

    for (const rule of element.dependsOn?.rules ?? []) {
      if (!ruleMatches(rule, values)) continue;

      for (const effect of rule.effects) {
        switch (effect.type) {
          case 'setVisibility':
            visible = effect.value === true;
            break;
          case 'setRequired':
            required = effect.value === true;
            break;
          case 'setFieldProps':
            if (effect.props?.minLength !== undefined) minLength = effect.props.minLength;
            if (effect.props?.maxLength !== undefined) maxLength = effect.props.maxLength;
            break;
          case 'filterOptions':
            allowedValues = effect.allowedValues ?? [];
            break;
        }
      }
    }

    // A hidden field is never required: demanding a value the user cannot see
    // produces a form that cannot be submitted and gives no clue why.
    if (!visible) {
      required = false;
    }

    state.set(element.jsonKey, { visible, required, minLength, maxLength, allowedValues });
  }

  return state;
}

/**
 * Strip values for fields that are hidden and marked `clearOnHide`.
 *
 * Without this, a field filled in and then hidden by a later answer keeps its
 * value and is submitted -- which at best confuses a reviewer and at worst
 * carries an adjustment the officer believes they removed.
 */
export function applyClearOnHide(
  definition: FormDefinition,
  values: FormValues,
  state: ResolvedFormState,
): FormValues {
  const cleared: Record<string, unknown> = { ...values };

  for (const element of flattenElements(definition)) {
    if (!holdsValue(element) || element.clearOnHide !== true) continue;
    const fieldState = state.get(element.jsonKey);
    if (fieldState !== undefined && !fieldState.visible) {
      delete cleared[element.jsonKey];
    }
  }

  return cleared;
}

// ---------------------------------------------------------------- comparisons

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Equality across the string/number boundary.
 *
 * Form values arrive as strings from a browser and as typed values from an
 * API client. A dropdown whose option value is "10" must match both.
 */
function looseEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || actual === undefined || expected === null || expected === undefined) {
    return false;
  }
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return String(actual) === String(expected);
  }
  return String(actual) === String(expected);
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((entry) => looseEquals(entry, expected));
  }
  if (typeof actual === 'string' && expected !== null && expected !== undefined) {
    return actual.includes(String(expected));
  }
  return false;
}

function toComparable(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (value instanceof Date) return value.getTime();
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isNaN(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}
