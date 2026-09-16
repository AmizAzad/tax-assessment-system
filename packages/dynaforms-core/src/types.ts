/**
 * The DynaForms element model.
 *
 * Plan reference: V2 sections 4.1-4.3; ADR-005.
 *
 * ## Status of this file
 *
 * This is a clean-room implementation of the element contract documented in
 * the V1 plan section 4, written because the upstream DynaForms source is not
 * available to this project. It is deliberately a faithful implementation of
 * the *documented* model rather than an improved one: when upstream source
 * does arrive, the value here is that the interface and the test suite already
 * encode the expected behaviour, so reconciliation is a merge rather than a
 * rewrite.
 *
 * ## Why this package has no framework dependency
 *
 * Client-side validation is a UX affordance and never a control. The API must
 * execute exactly the validation and dependency logic the browser ran, not a
 * re-implementation that will drift. That requires this code to run in Node
 * with no DOM and no Angular -- which is enforced by a test that asserts the
 * package imports nothing framework-specific.
 */

/** Field types. Numeric values match the documented upstream enum. */
export enum FieldType {
  TEXTBOX = 1,
  CHECKBOX = 2,
  TEXTAREA = 3,
  SECTION = 4,
  DATEPICKER = 5,
  DROPDOWN = 6,
  TOGGLESWITCH = 7,
  RADIOGROUP = 8,
  DIVIDER = 9,
  MULTISELECT = 10,
  NUMBER = 11,
  PASSWORD = 12,
  HEADER = 13,
  BUTTON = 14,
  CONTAINER = 15,
  TAB = 16,
  DIV = 17,
  FILE = 18,
  TIMEPICKER = 19,
  BOXWIDGET = 20,
  TABLE = 21,
  BUTTONGROUP = 22,
  FORMULA = 23,
  SIGNATURE = 24,
  PHONE = 25,
  EMAIL = 26,
  CAPTCHA = 27,
  AUTOCOMPLETE = 28,
  BANNER = 29,
}

/**
 * Types that hold a value.
 *
 * Layout and decoration nodes are walked but never validated or submitted.
 */
export const VALUE_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  FieldType.TEXTBOX,
  FieldType.CHECKBOX,
  FieldType.TEXTAREA,
  FieldType.DATEPICKER,
  FieldType.DROPDOWN,
  FieldType.TOGGLESWITCH,
  FieldType.RADIOGROUP,
  FieldType.MULTISELECT,
  FieldType.NUMBER,
  FieldType.PASSWORD,
  FieldType.FILE,
  FieldType.TIMEPICKER,
  FieldType.TABLE,
  FieldType.FORMULA,
  FieldType.SIGNATURE,
  FieldType.PHONE,
  FieldType.EMAIL,
  FieldType.AUTOCOMPLETE,
]);

/** Types that may contain children. */
export const CONTAINER_FIELD_TYPES: ReadonlySet<FieldType> = new Set([
  FieldType.SECTION,
  FieldType.CONTAINER,
  FieldType.TAB,
  FieldType.DIV,
  FieldType.BOXWIDGET,
  FieldType.BUTTONGROUP,
]);

export type DependencyOperator =
  'eq' | 'neq' | 'contains' | 'lt' | 'gt' | 'lte' | 'gte' | 'empty' | 'notEmpty';

export type DependencyEffectType =
  'setVisibility' | 'setRequired' | 'setFieldProps' | 'filterOptions';

export interface DependencyCondition {
  /** `jsonKey` of the field whose value is tested. */
  readonly field: string;
  readonly operator: DependencyOperator;
  /** Not required for `empty` / `notEmpty`. */
  readonly value?: unknown;
}

export interface DependencyEffect {
  readonly type: DependencyEffectType;
  /** setVisibility / setRequired. */
  readonly value?: boolean;
  /** setFieldProps: currently minLength and maxLength only, per the documented contract. */
  readonly props?: { readonly minLength?: number; readonly maxLength?: number };
  /** filterOptions: the option values that remain selectable. */
  readonly allowedValues?: readonly string[];
}

export interface DependencyRule {
  readonly conditions: readonly DependencyCondition[];
  /** How multiple conditions combine. Defaults to AND. */
  readonly combinator?: 'AND' | 'OR';
  readonly effects: readonly DependencyEffect[];
}

export interface RegexConfig {
  readonly pattern: string;
  readonly flags?: string;
  readonly errorKey?: string;
}

export interface FormulaValidationRule {
  readonly uuid: string;
  /** A boolean comparison, e.g. `@assessedAmount >= 0`. */
  readonly formula: string;
  readonly errorKey: string;
}

export interface SelectOption {
  readonly label: string;
  readonly value: string;
  readonly displayKey?: string;
}

/**
 * One node of a form definition.
 *
 * The tree is stored as JSONB. Only the keys this package reasons about are
 * modelled; presentation keys (styles, layout, typography) are carried through
 * untouched in `presentation`.
 */
export interface FormElement {
  readonly uuid: string;
  /** The key this field's value is stored under in the submission. */
  readonly jsonKey: string;
  readonly fieldType: FieldType;
  readonly displayKey?: string;

  readonly required?: boolean;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  /** When hidden by a dependency, clear the value rather than submitting a stale one. */
  readonly clearOnHide?: boolean;

  readonly dependsOn?: { readonly rules: readonly DependencyRule[] };

  // validation
  readonly regexConfig?: RegexConfig;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly max?: number;
  readonly minDate?: string;
  readonly maxDate?: string;
  readonly validationRules?: readonly FormulaValidationRule[];
  readonly errorMsgMetadata?: Readonly<Record<string, string>>;

  // calculation
  readonly formula?: string;
  /** Ordered selection rules; first match wins, otherwise `formula` runs. */
  readonly formulaRules?: readonly {
    readonly conditions: readonly DependencyCondition[];
    readonly combinator?: 'AND' | 'OR';
    readonly formula: string;
  }[];

  // numeric / currency
  readonly currency?: string;
  readonly isPercentage?: boolean;

  /**
   * The tax concept this field declares, for example `TRADING_PROFIT`.
   *
   * How a filed return becomes assessment input. Without it the platform
   * would need a hard-coded map from form field to tax meaning per form per
   * year, which is the configuration-driven design failing at the first step.
   *
   * Purely descriptive: the renderer ignores it. Only the evidence layer
   * reads it, and only on the server.
   */
  readonly taxConcept?: string;

  // options
  readonly options?: readonly SelectOption[];

  /**
   * Marks a field as populated by the server and rejected if the client
   * changes it. Calculation results render through this (ADR-006).
   */
  readonly source?: 'user' | 'server' | 'api_prefill';

  /**
   * Role codes for which this field is read-only.
   *
   * A documented divergence from upstream (ADR-005). Enforced BOTH in the
   * renderer and server-side on submit: hiding a field in a browser is not
   * access control.
   */
  readonly readOnlyForRoles?: readonly string[];

  readonly children?: readonly FormElement[];
  /** Presentation keys, carried through without interpretation. */
  readonly presentation?: Readonly<Record<string, unknown>>;
}

export interface FormDefinition {
  readonly schemaVersion: string;
  readonly root: readonly FormElement[];
}

/** A submission payload: jsonKey -> value. */
export type FormValues = Readonly<Record<string, unknown>>;

/** The resolved state of one field after dependencies have been applied. */
export interface ResolvedFieldState {
  readonly visible: boolean;
  readonly required: boolean;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Present only when a `filterOptions` effect narrowed the list. */
  readonly allowedValues?: readonly string[];
}

export type ResolvedFormState = ReadonlyMap<string, ResolvedFieldState>;

export interface ValidationError {
  readonly jsonKey: string;
  readonly errorKey: string;
  /** Machine-readable cause, for tests and logs. */
  readonly rule:
    | 'required'
    | 'pattern'
    | 'minLength'
    | 'maxLength'
    | 'min'
    | 'max'
    | 'minDate'
    | 'maxDate'
    | 'formula'
    | 'readOnly'
    | 'serverOwned'
    | 'notAnOption';
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

/** Walk every element depth-first, containers included. */
export function walkElements(
  elements: readonly FormElement[],
  visit: (element: FormElement) => void,
): void {
  for (const element of elements) {
    visit(element);
    if (element.children !== undefined) {
      walkElements(element.children, visit);
    }
  }
}

/** Every element in the definition, flattened. */
export function flattenElements(definition: FormDefinition): FormElement[] {
  const flat: FormElement[] = [];
  walkElements(definition.root, (element) => flat.push(element));
  return flat;
}

/** Index elements by `jsonKey` for lookup during dependency and formula evaluation. */
export function indexByJsonKey(definition: FormDefinition): Map<string, FormElement> {
  const index = new Map<string, FormElement>();
  walkElements(definition.root, (element) => {
    if (element.jsonKey !== '') {
      index.set(element.jsonKey, element);
    }
  });
  return index;
}

export function holdsValue(element: FormElement): boolean {
  return VALUE_FIELD_TYPES.has(element.fieldType);
}
