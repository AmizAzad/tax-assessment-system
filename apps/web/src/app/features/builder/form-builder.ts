import { Component, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';
import { FieldType, flattenElements, type FormElement } from '@tas/dynaforms-core';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { FormRenderer } from '../../dynaforms/form-renderer';
import { BuilderState, isContainerType } from './builder-state';
import { ElementProperties } from './element-properties';

interface PaletteEntry {
  readonly fieldType: FieldType;
  readonly label: string;
  readonly group: 'Layout' | 'Input' | 'Choice' | 'Computed' | 'Action';
}

interface SavedTemplate {
  readonly id: number;
  readonly templateCode: string;
  readonly version: number;
  readonly status: string;
}

/**
 * The visual form builder.
 *
 * Plan reference: V2 sections 4.1, 4.3, 11.4, 18.1; ADR-005, ADR-006.
 *
 * Four panes: a palette, the element tree, the properties of whatever is
 * selected, and a live preview.
 *
 * ## The preview is the real renderer
 *
 * Not a mock-up of one. It is the same `FormRenderer` an officer will use,
 * given the definition being edited, running the same dependency and
 * validation engines as the server (ADR-005). An author sees exactly what
 * their rules will do — including a field that never appears because its
 * condition can never be true.
 *
 * ## Problems are shown while editing, not only at publish
 *
 * Duplicate keys, dangling rule references and circular formulas are checked
 * continuously. Discovering a duplicate key after twenty fields is much worse
 * than at the moment it is created. The server checks again on publish and
 * remains the authority.
 */
@Component({
  selector: 'tas-form-builder',
  standalone: true,
  imports: [FormRenderer, ElementProperties],
  providers: [BuilderState],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './form-builder.scss',
  templateUrl: './form-builder.html',
})
export class FormBuilder {
  readonly state = inject(BuilderState);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly saving = signal(false);
  readonly saved = signal<SavedTemplate | null>(null);
  readonly saveError = signal<string | null>(null);
  readonly previewMode = signal<'edit' | 'preview'>('edit');

  /** Authoring templates is TA_ADMIN. The API denies regardless. */
  readonly canAuthor = computed(() => {
    this.auth.caller();
    return this.auth.canInvoke('POST', '/api/v1/forms/templates');
  });

  readonly roleCodes = computed(() => this.auth.roleCodes());

  readonly palette: readonly PaletteEntry[] = [
    { fieldType: FieldType.SECTION, label: 'Section', group: 'Layout' },
    { fieldType: FieldType.DIV, label: 'Group', group: 'Layout' },
    { fieldType: FieldType.HEADER, label: 'Heading', group: 'Layout' },
    { fieldType: FieldType.DIVIDER, label: 'Divider', group: 'Layout' },
    { fieldType: FieldType.BANNER, label: 'Banner', group: 'Layout' },

    { fieldType: FieldType.TEXTBOX, label: 'Text', group: 'Input' },
    { fieldType: FieldType.TEXTAREA, label: 'Long text', group: 'Input' },
    { fieldType: FieldType.NUMBER, label: 'Number', group: 'Input' },
    { fieldType: FieldType.DATEPICKER, label: 'Date', group: 'Input' },
    { fieldType: FieldType.EMAIL, label: 'E-mail', group: 'Input' },
    { fieldType: FieldType.FILE, label: 'File', group: 'Input' },

    { fieldType: FieldType.DROPDOWN, label: 'Dropdown', group: 'Choice' },
    { fieldType: FieldType.RADIOGROUP, label: 'Radio group', group: 'Choice' },
    { fieldType: FieldType.MULTISELECT, label: 'Multi-select', group: 'Choice' },
    { fieldType: FieldType.CHECKBOX, label: 'Checkbox', group: 'Choice' },

    { fieldType: FieldType.FORMULA, label: 'Computed', group: 'Computed' },

    { fieldType: FieldType.BUTTONGROUP, label: 'Button group', group: 'Action' },
    { fieldType: FieldType.BUTTON, label: 'Button', group: 'Action' },
  ];

  readonly paletteGroups = computed(() => {
    const groups = new Map<string, PaletteEntry[]>();
    for (const entry of this.palette) {
      const list = groups.get(entry.group) ?? [];
      list.push(entry);
      groups.set(entry.group, list);
    }
    return [...groups.entries()].map(([name, entries]) => ({ name, entries }));
  });

  /** The tree, flattened with depth so it renders without recursion. */
  readonly flatTree = computed(() => {
    const rows: { element: FormElement; depth: number }[] = [];
    const walk = (elements: readonly FormElement[], depth: number): void => {
      for (const element of elements) {
        rows.push({ element, depth });
        if (element.children !== undefined) walk(element.children, depth + 1);
      }
    };
    walk(this.state.root(), 0);
    return rows;
  });

  readonly fieldCount = computed(
    () =>
      flattenElements(this.state.definition()).filter((e) => !isContainerType(e.fieldType)).length,
  );

  readonly FieldType = FieldType;

  add(fieldType: FieldType): void {
    this.state.add(fieldType);
    this.saved.set(null);
  }

  labelFor(element: FormElement): string {
    return element.displayKey ?? element.jsonKey;
  }

  typeNameOf(element: FormElement): string {
    return FieldType[element.fieldType];
  }

  togglePreview(): void {
    this.previewMode.update((mode) => (mode === 'edit' ? 'preview' : 'edit'));
  }

  /**
   * Save as a draft, then publish.
   *
   * Two calls because they are two different acts: a draft may be
   * half-finished, a published template is about to be put in front of an
   * officer. The server validates at publish and can still refuse — this
   * client-side check exists to avoid a pointless round trip, not to replace it.
   */
  async saveAndPublish(publish: boolean): Promise<void> {
    this.saveError.set(null);

    if (this.state.hasErrors()) {
      this.saveError.set('Fix the errors listed above before saving.');
      return;
    }

    this.saving.set(true);
    try {
      const created = await this.api.post<SavedTemplate>('/forms/templates', {
        categoryCode: this.state.categoryCode(),
        templateCode: this.state.templateCode(),
        displayKey: this.state.displayKey(),
        definition: this.state.definition(),
        appliesToYear: this.state.appliesToYear() || undefined,
      });

      const final = publish
        ? await this.api.post<SavedTemplate>(`/forms/templates/${created.id}/publish`, {})
        : created;

      this.saved.set(final);
    } catch (error) {
      this.saveError.set(describeError(error));
    } finally {
      this.saving.set(false);
    }
  }

  onMetaChange(field: 'templateCode' | 'displayKey' | 'appliesToYear', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.state[field].set(value);
    this.saved.set(null);
  }
}

/**
 * Turn an HTTP failure into something an author can act on.
 *
 * A publish rejection carries the server's list of problems; showing "400 Bad
 * Request" would hide the one thing that matters.
 */
function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'error' in error) {
    const body = (error as { error?: { message?: string; problems?: unknown[] } }).error;
    if (body?.problems !== undefined && Array.isArray(body.problems)) {
      const detail = body.problems
        .map((problem) =>
          typeof problem === 'object' && problem !== null && 'message' in problem
            ? String((problem as { message: unknown }).message)
            : String(problem),
        )
        .join('; ');
      return `${body.message ?? 'The server rejected the template'}: ${detail}`;
    }
    if (body?.message !== undefined) {
      return String(body.message);
    }
  }
  return error instanceof Error ? error.message : 'The template could not be saved';
}
