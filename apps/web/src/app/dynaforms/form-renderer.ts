import { CommonModule } from '@angular/common';
import {
  Component,
  ChangeDetectionStrategy,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DraftStore } from '../core/draft-store';
import { I18nService } from '../core/i18n.service';
import { FormsModule } from '@angular/forms';
import {
  FieldType,
  applyClearOnHide,
  contextFromValues,
  evaluateFormula,
  flattenElements,
  resolveFormState,
  validateSubmission,
  type FormDefinition,
  type FormElement,
  type FormValues,
  type ValidationError,
} from '@tas/dynaforms-core';

export interface FormSubmitEvent {
  readonly actionCode: string;
  readonly values: FormValues;
}

/**
 * Renders a DynaForms definition.
 *
 * Plan reference: V2 sections 4.1, 11.4, 18.2; ADR-005, ADR-006.
 *
 * ## This is the only thing that renders assessment fields
 *
 * The plan is explicit (18.2): the working area is always this renderer, never
 * hand-written form markup. V1 recorded what happens otherwise — a 2,500-line
 * component that could not be configured for a new jurisdiction. A form is
 * configuration; if a screen needs a field, the answer is to add it to the
 * template.
 *
 * ## It runs the same engines as the server
 *
 * Dependency resolution and validation come from `@tas/dynaforms-core`, which
 * the API also imports. Not a re-implementation — the same code, so the two
 * cannot drift (ADR-005). What the user sees marked invalid is what the server
 * will reject.
 *
 * ## Formula values are indicative only
 *
 * Computed fields are evaluated here for immediate feedback while an officer
 * types. They are never the legal figure: anything `source: 'server'` renders
 * read-only and is rejected by the API if changed (ADR-006).
 */
@Component({
  selector: 'tas-form-renderer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './form-renderer.scss',
  templateUrl: './form-renderer.html',
})
export class FormRenderer {
  readonly definition = input.required<FormDefinition>();
  readonly initialValues = input<FormValues>({});
  /** Caller roles, for `readOnlyForRoles`. Mirrored server-side on submit. */
  readonly roleCodes = input<readonly string[]>([]);
  readonly readOnly = input<boolean>(false);
  /**
   * Where to hold unsent work.
   *
   * Absent by default: a form used for preview or configuration has no draft
   * worth keeping, and autosaving one would put stale values in front of the
   * next person who opened it. A screen where an officer is entering real
   * work supplies a key, and gets autosave (plan 18.3).
   */
  readonly draftKey = input<string | null>(null);

  readonly submitted = output<FormSubmitEvent>();
  readonly valueChanged = output<FormValues>();
  /** Emitted when unsent work was put back, so the screen can say so. */
  readonly draftRestored = output<Date>();

  private readonly drafts = inject(DraftStore);
  private readonly i18n = inject(I18nService);
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly valuesSignal = signal<FormValues>({});
  /** Errors are shown only after an attempted submit, not while typing. */
  private readonly showErrors = signal(false);

  readonly values = this.valuesSignal.asReadonly();

  /** Field state after dependencies: visibility, required, filtered options. */
  readonly state = computed(() => resolveFormState(this.definition(), this.valuesSignal()));

  readonly errors = computed<readonly ValidationError[]>(() => {
    if (!this.showErrors()) return [];
    return validateSubmission(this.definition(), this.valuesSignal(), {
      roleCodes: this.roleCodes(),
      state: this.state(),
    }).errors;
  });

  private readonly errorsByField = computed(() => {
    const byField = new Map<string, ValidationError[]>();
    for (const error of this.errors()) {
      const list = byField.get(error.jsonKey) ?? [];
      list.push(error);
      byField.set(error.jsonKey, list);
    }
    return byField;
  });

  /** Top-level nodes, in document order. */
  readonly rootElements = computed(() => this.definition().root);

  constructor() {
    // Seeding from an input in a constructor effect would fight change
    // detection; the parent sets values once through `reset`.
    queueMicrotask(() => {
      const key = this.draftKey();
      const draft = key === null ? null : this.drafts.load(key);

      // A held draft wins over the initial values, because it is the later of
      // the two and it is the officer's own work. It is announced rather than
      // applied silently — see DraftStore.
      if (draft !== null) {
        this.valuesSignal.set({ ...this.initialValues(), ...(draft.values as FormValues) });
        this.draftRestored.emit(draft.savedAt);
        return;
      }

      this.valuesSignal.set({ ...this.initialValues() });
    });
  }

  reset(values: FormValues): void {
    this.valuesSignal.set({ ...values });
    this.showErrors.set(false);
  }

  // ------------------------------------------------------------- field state

  isVisible(element: FormElement): boolean {
    return this.state().get(element.jsonKey)?.visible ?? true;
  }

  isRequired(element: FormElement): boolean {
    return this.state().get(element.jsonKey)?.required ?? false;
  }

  /**
   * Whether a field is locked.
   *
   * Three reasons, all of which the server also enforces: the whole form is
   * read-only, the field is server-owned (a calculation result), or the
   * caller's roles exclude editing it.
   */
  isDisabled(element: FormElement): boolean {
    if (this.readOnly()) return true;
    if (element.source === 'server') return true;
    if (element.disabled === true) return true;
    const restricted = element.readOnlyForRoles ?? [];
    return restricted.some((role) => this.roleCodes().includes(role));
  }

  /**
   * Options after any `filterOptions` dependency has narrowed them, with
   * their labels resolved.
   *
   * A display key is resolved through the loaded language bundle and falls
   * back to the label the template carries. Without this, a form configured
   * with display keys renders a column of raw keys, which is how a
   * translatable form ends up being authored with English hard-coded in it.
   */
  optionsFor(element: FormElement): readonly { label: string; value: string }[] {
    const allowed = this.state().get(element.jsonKey)?.allowedValues;
    const options = element.options ?? [];
    const visible =
      allowed === undefined ? options : options.filter((option) => allowed.includes(option.value));

    return visible.map((option) => ({
      value: option.value,
      label:
        option.displayKey === undefined
          ? option.label
          : this.i18n.t(option.displayKey, option.label),
    }));
  }

  errorsFor(element: FormElement): readonly ValidationError[] {
    return this.errorsByField().get(element.jsonKey) ?? [];
  }

  // ---------------------------------------------------------------- values

  valueOf(element: FormElement): unknown {
    return this.valuesSignal()[element.jsonKey] ?? '';
  }

  onValueChange(element: FormElement, value: unknown): void {
    const next = { ...this.valuesSignal(), [element.jsonKey]: value };
    this.valuesSignal.set(next);
    this.valueChanged.emit(next);
    this.autosave(next);
  }

  /**
   * Hold what has been typed, debounced.
   *
   * Local only. Nothing here reaches the API, so a half-finished form never
   * appears in the case record (plan 18.3, and see `DraftStore`).
   */
  private autosave(values: FormValues): void {
    const key = this.draftKey();
    if (key === null) {
      return;
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => this.drafts.save(key, values), 800);
  }

  /** Called by the parent once a submission has been accepted. */
  clearDraft(): void {
    const key = this.draftKey();
    if (key !== null) {
      this.drafts.clear(key);
    }
  }

  onCheckboxChange(element: FormElement, event: Event): void {
    this.onValueChange(element, (event.target as HTMLInputElement).checked);
  }

  onInput(element: FormElement, event: Event): void {
    this.onValueChange(element, (event.target as HTMLInputElement).value);
  }

  onNumberInput(element: FormElement, event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    // Kept as a string. Parsing to a JS number here would be the first step
    // towards a monetary value going through floating point (ADR-007).
    this.onValueChange(element, raw === '' ? null : raw);
  }

  onMultiSelectChange(element: FormElement, event: Event): void {
    const selected = Array.from((event.target as HTMLSelectElement).selectedOptions).map(
      (option) => option.value,
    );
    this.onValueChange(element, selected);
  }

  /**
   * The indicative value of a computed field.
   *
   * Evaluated for feedback while typing. A formula that cannot evaluate — a
   * half-filled form, a missing field — shows a dash rather than an error: the
   * user is mid-edit, not wrong.
   */
  formulaValue(element: FormElement): string {
    if (element.formula === undefined) return '';
    try {
      const meta: Record<string, { currency?: string; isPercentage?: boolean }> = {};
      for (const other of flattenElements(this.definition())) {
        if (other.jsonKey !== '') {
          meta[other.jsonKey] = {
            currency: other.currency,
            isPercentage: other.isPercentage,
          };
        }
      }
      const result = evaluateFormula(element.formula, contextFromValues(this.valuesSignal(), meta));
      if (result.kind === 'date') return result.value.toISOString().slice(0, 10);
      return String(result.value);
    } catch {
      return '—';
    }
  }

  // ---------------------------------------------------------------- actions

  /**
   * Attempt a submit.
   *
   * Validates locally to give immediate feedback and to avoid a pointless
   * round trip. The server validates again and is the authority: this check
   * passing does not mean the submission will be accepted.
   */
  submit(actionCode: string): void {
    this.showErrors.set(true);

    const state = this.state();
    const values = applyClearOnHide(this.definition(), this.valuesSignal(), state);

    // A draft save is not a submission and is not gated on validity.
    if (actionCode === 'SAVE_DRAFT') {
      this.submitted.emit({ actionCode, values });
      return;
    }

    const result = validateSubmission(this.definition(), values, {
      roleCodes: this.roleCodes(),
      state,
    });
    if (!result.valid) {
      return;
    }

    this.submitted.emit({ actionCode, values });
  }

  /** Action buttons, taken from the form's ButtonGroup (plan 11.4). */
  readonly actions = computed(() => {
    const buttons: { code: string; label: string }[] = [];
    for (const element of flattenElements(this.definition())) {
      if (element.fieldType === FieldType.BUTTON && element.jsonKey !== '') {
        buttons.push({
          code: element.jsonKey.toUpperCase(),
          label: this.i18n.t(element.displayKey ?? element.jsonKey, element.jsonKey),
        });
      }
    }
    return buttons;
  });

  // ------------------------------------------------------------- templating

  readonly FieldType = FieldType;

  /** Layout nodes are walked for their children; they hold no value. */
  isContainer(element: FormElement): boolean {
    return (
      element.fieldType === FieldType.SECTION ||
      element.fieldType === FieldType.CONTAINER ||
      element.fieldType === FieldType.DIV ||
      element.fieldType === FieldType.TAB ||
      element.fieldType === FieldType.BOXWIDGET ||
      element.fieldType === FieldType.BUTTONGROUP
    );
  }

  /**
   * Whether a container has anything of its own to draw.
   *
   * Buttons are collected into the form's action bar, not drawn where the
   * template places them, so a button group left in the tree rendered as an
   * empty bordered box with a legend and nothing inside it.
   */
  hasContent(element: FormElement): boolean {
    return (element.children ?? []).some((child) =>
      this.isContainer(child) ? this.hasContent(child) : child.fieldType !== FieldType.BUTTON,
    );
  }

  /**
   * A field's label.
   *
   * Resolved through the language bundle. An unresolved key renders as the key
   * itself rather than as blank, matching the server: a missing translation
   * should look obviously wrong and be findable by grep, not silently leave an
   * officer with an unlabelled box (plan 6.7).
   */
  labelFor(element: FormElement): string {
    const key = element.displayKey ?? element.jsonKey;
    return this.i18n.t(key, key);
  }

  trackByUuid(_index: number, element: FormElement): string {
    return element.uuid;
  }
}
