import { resolveFormState } from './dependency-engine';
import { contextFromValues, evaluateValidation } from './formula/evaluator';
import {
  flattenElements,
  holdsValue,
  type FormDefinition,
  type FormElement,
  type FormValues,
  type ResolvedFormState,
  type ValidationError,
  type ValidationResult,
} from './types';

/**
 * The validation engine.
 *
 * Plan reference: V2 sections 4.1, 9.4, 20; ADR-005, ADR-006.
 *
 * ## The point of this file
 *
 * Client-side validation is an affordance. This is the control. The same code
 * runs in the browser for immediate feedback and on the server as the actual
 * gate, so the two cannot drift.
 *
 * Three checks here exist specifically because a browser cannot be trusted to
 * perform them:
 *
 *   - `serverOwned`  a field marked `source: 'server'` -- a calculation result
 *                    -- must not be changed by the client (ADR-006)
 *   - `readOnly`     a field the caller's roles may not edit must be rejected
 *                    if changed, not merely hidden (plan 9.4)
 *   - `notAnOption`  a dropdown value outside the (possibly filtered) option
 *                    list must be rejected, whatever the browser sent
 */

export interface ValidationOptions {
  /** Caller role codes, for `readOnlyForRoles` enforcement. */
  readonly roleCodes?: readonly string[];
  /**
   * The previously stored values.
   *
   * Required to enforce `serverOwned` and `readOnly`: both are "did this
   * change" checks, which cannot be answered from the incoming payload alone.
   */
  readonly previousValues?: FormValues;
  /** Pre-resolved state, when the caller has already computed it. */
  readonly state?: ResolvedFormState;
}

export function validateSubmission(
  definition: FormDefinition,
  values: FormValues,
  options: ValidationOptions = {},
): ValidationResult {
  const state = options.state ?? resolveFormState(definition, values);
  const errors: ValidationError[] = [];
  const elements = flattenElements(definition);

  const meta: Record<string, { currency?: string; isPercentage?: boolean }> = {};
  for (const element of elements) {
    if (element.jsonKey !== '') {
      meta[element.jsonKey] = {
        currency: element.currency,
        isPercentage: element.isPercentage,
      };
    }
  }

  for (const element of elements) {
    if (!holdsValue(element)) continue;

    const fieldState = state.get(element.jsonKey);
    // A field hidden by a dependency is not validated: its value is either
    // cleared or irrelevant.
    if (fieldState !== undefined && !fieldState.visible) continue;

    const value = values[element.jsonKey];
    const changed = hasChanged(value, options.previousValues?.[element.jsonKey]);

    // ---------------------------------------------------- trust-boundary checks
    if (element.source === 'server' && changed) {
      errors.push({
        jsonKey: element.jsonKey,
        errorKey: `ta.error.${element.jsonKey}.serverOwned`,
        rule: 'serverOwned',
      });
      continue;
    }

    if (changed && isReadOnlyFor(element, options.roleCodes ?? [])) {
      errors.push({
        jsonKey: element.jsonKey,
        errorKey: `ta.error.${element.jsonKey}.readOnly`,
        rule: 'readOnly',
      });
      continue;
    }

    // ------------------------------------------------------------- presence
    const empty = isEmpty(value);
    if (fieldState?.required === true && empty) {
      errors.push({
        jsonKey: element.jsonKey,
        errorKey: errorKeyFor(element, 'required'),
        rule: 'required',
      });
      continue;
    }
    if (empty) continue;

    // -------------------------------------------------------------- options
    if (element.options !== undefined && element.options.length > 0) {
      const permitted = new Set(
        fieldState?.allowedValues ?? element.options.map((option) => option.value),
      );
      const selected = Array.isArray(value) ? value : [value];
      const invalid = selected.filter((entry) => !permitted.has(String(entry)));
      if (invalid.length > 0) {
        errors.push({
          jsonKey: element.jsonKey,
          errorKey: errorKeyFor(element, 'notAnOption'),
          rule: 'notAnOption',
        });
        continue;
      }
    }

    // --------------------------------------------------------------- string
    const asString = typeof value === 'string' ? value : undefined;

    const minLength = fieldState?.minLength ?? element.minLength;
    if (minLength !== undefined && asString !== undefined && asString.length < minLength) {
      errors.push({
        jsonKey: element.jsonKey,
        errorKey: errorKeyFor(element, 'minLength'),
        rule: 'minLength',
      });
    }

    const maxLength = fieldState?.maxLength ?? element.maxLength;
    if (maxLength !== undefined && asString !== undefined && asString.length > maxLength) {
      errors.push({
        jsonKey: element.jsonKey,
        errorKey: errorKeyFor(element, 'maxLength'),
        rule: 'maxLength',
      });
    }

    if (element.regexConfig !== undefined && asString !== undefined) {
      // Anchored so a partial match does not pass a format check: a TIN
      // pattern must match the whole value, not a substring of it.
      const pattern = new RegExp(`^(?:${element.regexConfig.pattern})$`, element.regexConfig.flags);
      if (!pattern.test(asString)) {
        errors.push({
          jsonKey: element.jsonKey,
          errorKey: element.regexConfig.errorKey ?? errorKeyFor(element, 'pattern'),
          rule: 'pattern',
        });
      }
    }

    // -------------------------------------------------------------- numeric
    const asNumber = toNumber(value);
    if (asNumber !== undefined) {
      if (element.min !== undefined && asNumber < element.min) {
        errors.push({
          jsonKey: element.jsonKey,
          errorKey: errorKeyFor(element, 'min'),
          rule: 'min',
        });
      }
      if (element.max !== undefined && asNumber > element.max) {
        errors.push({
          jsonKey: element.jsonKey,
          errorKey: errorKeyFor(element, 'max'),
          rule: 'max',
        });
      }
    }

    // ----------------------------------------------------------------- date
    const asDate = toDate(value);
    if (asDate !== undefined) {
      const minDate = element.minDate === undefined ? undefined : toDate(element.minDate);
      const maxDate = element.maxDate === undefined ? undefined : toDate(element.maxDate);
      if (minDate !== undefined && asDate < minDate) {
        errors.push({
          jsonKey: element.jsonKey,
          errorKey: errorKeyFor(element, 'minDate'),
          rule: 'minDate',
        });
      }
      if (maxDate !== undefined && asDate > maxDate) {
        errors.push({
          jsonKey: element.jsonKey,
          errorKey: errorKeyFor(element, 'maxDate'),
          rule: 'maxDate',
        });
      }
    }
  }

  // ------------------------------------------------------ formula validations
  const context = contextFromValues(values, meta);
  for (const element of elements) {
    const fieldState = state.get(element.jsonKey);
    if (fieldState !== undefined && !fieldState.visible) continue;

    for (const rule of element.validationRules ?? []) {
      let satisfied: boolean;
      try {
        satisfied = evaluateValidation(rule.formula, context);
      } catch {
        // A formula that cannot evaluate -- a missing field, a type mismatch
        // -- is not a validation failure to report to the user. The form is
        // misconfigured, and failing the rule here would block a submission
        // for a reason the user cannot act on.
        continue;
      }
      if (!satisfied) {
        errors.push({
          jsonKey: element.jsonKey,
          errorKey: rule.errorKey,
          rule: 'formula',
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Whether any of the caller's roles makes this field read-only. */
export function isReadOnlyFor(element: FormElement, roleCodes: readonly string[]): boolean {
  if (element.readOnlyForRoles === undefined || element.readOnlyForRoles.length === 0) {
    return false;
  }
  return element.readOnlyForRoles.some((role) => roleCodes.includes(role));
}

function errorKeyFor(element: FormElement, rule: string): string {
  return element.errorMsgMetadata?.[rule] ?? `ta.error.${element.jsonKey}.${rule}`;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function hasChanged(incoming: unknown, previous: unknown): boolean {
  if (previous === undefined) {
    // No baseline to compare against: treat a present value as a change so a
    // first submission cannot smuggle in a server-owned figure.
    return !isEmpty(incoming);
  }
  if (incoming === previous) return false;
  if (incoming instanceof Date && previous instanceof Date) {
    return incoming.getTime() !== previous.getTime();
  }
  if (typeof incoming === 'object' || typeof previous === 'object') {
    return JSON.stringify(incoming) !== JSON.stringify(previous);
  }
  return String(incoming) !== String(previous);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const numeric = Number(value);
  return Number.isNaN(numeric) ? undefined : numeric;
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return undefined;
  // A plain number in a string is a number, not a date, whatever Date.parse
  // might make of it.
  if (!Number.isNaN(Number(value))) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}
