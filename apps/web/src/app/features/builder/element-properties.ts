import { Component, ChangeDetectionStrategy, computed, inject } from '@angular/core';
import {
  FieldType,
  flattenElements,
  type DependencyEffect,
  type DependencyRule,
  type FormElement,
  type SelectOption,
} from '@tas/dynaforms-core';
import { BuilderState, isContainerType } from './builder-state';

/**
 * Properties of the selected element.
 *
 * Plan reference: V2 sections 4.1, 9.4, 11.3; ADR-005, ADR-006.
 *
 * The panel is driven by the element's type: a dropdown gets an option editor,
 * a formula field gets an expression box, everything gets a key and a label.
 * Showing every property for every type would bury the three that matter.
 *
 * Two properties here are security-relevant and labelled as such rather than
 * left as bare checkboxes:
 *
 *   - `source: 'server'` marks a value the client may not set (ADR-006)
 *   - `readOnlyForRoles` is enforced server-side on submit, not just here
 */
@Component({
  selector: 'tas-element-properties',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './element-properties.scss',
  templateUrl: './element-properties.html',
})
export class ElementProperties {
  readonly state = inject(BuilderState);

  readonly element = this.state.selected;
  readonly FieldType = FieldType;

  /** Keys a dependency rule can watch: every other field in the form. */
  readonly availableKeys = computed(() => {
    const current = this.element();
    return flattenElements(this.state.definition())
      .filter((e) => e.jsonKey !== '' && e.uuid !== current?.uuid && !isContainerType(e.fieldType))
      .map((e) => e.jsonKey);
  });

  readonly isChoice = computed(() => {
    const type = this.element()?.fieldType;
    return (
      type === FieldType.DROPDOWN || type === FieldType.RADIOGROUP || type === FieldType.MULTISELECT
    );
  });

  readonly isNumeric = computed(() => this.element()?.fieldType === FieldType.NUMBER);
  readonly isText = computed(() => {
    const type = this.element()?.fieldType;
    return type === FieldType.TEXTBOX || type === FieldType.TEXTAREA || type === FieldType.EMAIL;
  });
  readonly isFormula = computed(() => this.element()?.fieldType === FieldType.FORMULA);
  readonly isContainer = computed(() => {
    const type = this.element()?.fieldType;
    return type !== undefined && isContainerType(type);
  });

  readonly roleOptions = [
    'TA_TAXPAYER',
    'TA_ASSESSOR',
    'TA_SPECIALIST',
    'TA_REVIEWER',
    'TA_APPROVER_L1',
    'TA_APPROVER_L2',
    'TA_APPROVER_L3',
    'TA_SUPERVISOR',
  ];

  readonly operators = [
    { value: 'eq', label: 'equals' },
    { value: 'neq', label: 'does not equal' },
    { value: 'contains', label: 'contains' },
    { value: 'lt', label: 'is less than' },
    { value: 'gt', label: 'is greater than' },
    { value: 'lte', label: 'is at most' },
    { value: 'gte', label: 'is at least' },
    { value: 'empty', label: 'is empty' },
    { value: 'notEmpty', label: 'is not empty' },
  ];

  // ------------------------------------------------------------ basic props

  patch(changes: Partial<FormElement>): void {
    const element = this.element();
    if (element === null) return;
    this.state.update(element.uuid, changes);
  }

  onText(field: keyof FormElement, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.patch({ [field]: value === '' ? undefined : value } as Partial<FormElement>);
  }

  onNumber(field: keyof FormElement, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    this.patch({ [field]: raw === '' ? undefined : Number(raw) } as Partial<FormElement>);
  }

  onFlag(field: keyof FormElement, event: Event): void {
    this.patch({ [field]: (event.target as HTMLInputElement).checked } as Partial<FormElement>);
  }

  onSourceChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.patch({ source: value === '' ? undefined : (value as FormElement['source']) });
  }

  toggleRole(role: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.element()?.readOnlyForRoles ?? [];
    const next = checked ? [...current, role] : current.filter((r) => r !== role);
    this.patch({ readOnlyForRoles: next.length === 0 ? undefined : next });
  }

  isRoleReadOnly(role: string): boolean {
    return (this.element()?.readOnlyForRoles ?? []).includes(role);
  }

  // ---------------------------------------------------------------- options

  addOption(): void {
    const options = this.element()?.options ?? [];
    const next: SelectOption = {
      label: `Option ${options.length + 1}`,
      value: `OPTION_${options.length + 1}`,
    };
    this.patch({ options: [...options, next] });
  }

  updateOption(index: number, field: 'label' | 'value', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    const options = [...(this.element()?.options ?? [])];
    const existing = options[index];
    if (existing === undefined) return;
    options[index] = { ...existing, [field]: value };
    this.patch({ options });
  }

  removeOption(index: number): void {
    const options = (this.element()?.options ?? []).filter((_, i) => i !== index);
    this.patch({ options: options.length === 0 ? undefined : options });
  }

  // ------------------------------------------------------------ dependencies

  get rules(): readonly DependencyRule[] {
    return this.element()?.dependsOn?.rules ?? [];
  }

  addRule(): void {
    const watchable = this.availableKeys();
    if (watchable.length === 0) return;

    const rule: DependencyRule = {
      conditions: [{ field: watchable[0]!, operator: 'eq', value: '' }],
      combinator: 'AND',
      effects: [{ type: 'setVisibility', value: true }],
    };
    this.patch({ dependsOn: { rules: [...this.rules, rule] } });
  }

  removeRule(index: number): void {
    const rules = this.rules.filter((_, i) => i !== index);
    this.patch({ dependsOn: rules.length === 0 ? undefined : { rules } });
  }

  updateCondition(
    ruleIndex: number,
    conditionIndex: number,
    field: 'field' | 'operator' | 'value',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    const rules = this.rules.map((rule, i) => {
      if (i !== ruleIndex) return rule;
      const conditions = rule.conditions.map((condition, j) =>
        j === conditionIndex ? { ...condition, [field]: value } : condition,
      );
      return { ...rule, conditions };
    });
    this.patch({ dependsOn: { rules } });
  }

  addCondition(ruleIndex: number): void {
    const watchable = this.availableKeys();
    if (watchable.length === 0) return;
    const rules = this.rules.map((rule, i) =>
      i === ruleIndex
        ? {
            ...rule,
            conditions: [
              ...rule.conditions,
              { field: watchable[0]!, operator: 'eq' as const, value: '' },
            ],
          }
        : rule,
    );
    this.patch({ dependsOn: { rules } });
  }

  removeCondition(ruleIndex: number, conditionIndex: number): void {
    const rules = this.rules
      .map((rule, i) =>
        i === ruleIndex
          ? { ...rule, conditions: rule.conditions.filter((_, j) => j !== conditionIndex) }
          : rule,
      )
      // A rule with no conditions can never match, so drop it rather than
      // leaving something that silently does nothing.
      .filter((rule) => rule.conditions.length > 0);
    this.patch({ dependsOn: rules.length === 0 ? undefined : { rules } });
  }

  setCombinator(ruleIndex: number, event: Event): void {
    const combinator = (event.target as HTMLSelectElement).value as 'AND' | 'OR';
    const rules = this.rules.map((rule, i) => (i === ruleIndex ? { ...rule, combinator } : rule));
    this.patch({ dependsOn: { rules } });
  }

  setEffectType(ruleIndex: number, event: Event): void {
    const type = (event.target as HTMLSelectElement).value as DependencyEffect['type'];
    const effect: DependencyEffect =
      type === 'filterOptions'
        ? { type, allowedValues: [] }
        : type === 'setFieldProps'
          ? { type, props: {} }
          : { type, value: true };
    const rules = this.rules.map((rule, i) =>
      i === ruleIndex ? { ...rule, effects: [effect] } : rule,
    );
    this.patch({ dependsOn: { rules } });
  }

  setEffectValue(ruleIndex: number, event: Event): void {
    const value = (event.target as HTMLSelectElement).value === 'true';
    const rules = this.rules.map((rule, i) =>
      i === ruleIndex
        ? { ...rule, effects: rule.effects.map((effect) => ({ ...effect, value })) }
        : rule,
    );
    this.patch({ dependsOn: { rules } });
  }

  /** Comma-separated option values that survive a `filterOptions` effect. */
  setAllowedValues(ruleIndex: number, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const allowedValues = raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '');
    const rules = this.rules.map((rule, i) =>
      i === ruleIndex
        ? { ...rule, effects: rule.effects.map((effect) => ({ ...effect, allowedValues })) }
        : rule,
    );
    this.patch({ dependsOn: { rules } });
  }

  allowedValuesOf(rule: DependencyRule): string {
    return (rule.effects[0]?.allowedValues ?? []).join(', ');
  }

  effectTypeOf(rule: DependencyRule): string {
    return rule.effects[0]?.type ?? 'setVisibility';
  }

  effectValueOf(rule: DependencyRule): string {
    return String(rule.effects[0]?.value ?? true);
  }
}
