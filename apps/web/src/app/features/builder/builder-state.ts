import { Injectable, computed, signal } from '@angular/core';
import {
  CONTAINER_FIELD_TYPES,
  FieldType,
  findCircularReferences,
  flattenElements,
  type FormDefinition,
  type FormElement,
} from '@tas/dynaforms-core';

export interface BuilderProblem {
  readonly severity: 'error' | 'warning';
  readonly elementUuid?: string;
  readonly message: string;
}

/**
 * Editing state for the form builder.
 *
 * Plan reference: V2 sections 4.1, 4.3, 11.4; ADR-005.
 *
 * ## The document being edited is a FormDefinition
 *
 * Not a builder-specific model that is later converted. The builder mutates
 * exactly the structure the renderer consumes and the API stores, so the
 * preview pane is the real renderer rather than an approximation, and there is
 * no translation step to drift.
 *
 * ## Every mutation returns a new tree
 *
 * Signals compare by reference, and an immutable update is also what makes
 * undo a matter of keeping the previous root rather than replaying inverse
 * operations.
 */
@Injectable()
export class BuilderState {
  private readonly rootSignal = signal<readonly FormElement[]>([]);
  private readonly selectedUuidSignal = signal<string | null>(null);
  private readonly history = signal<readonly (readonly FormElement[])[]>([]);

  readonly templateCode = signal('TA-NEW');
  readonly displayKey = signal('New form');
  readonly categoryCode = signal('TAX');
  readonly appliesToYear = signal('');

  readonly root = this.rootSignal.asReadonly();
  readonly selectedUuid = this.selectedUuidSignal.asReadonly();
  readonly canUndo = computed(() => this.history().length > 0);

  /** The document, in the shape the renderer and the API both expect. */
  readonly definition = computed<FormDefinition>(() => ({
    schemaVersion: '1.0.0',
    root: this.rootSignal(),
  }));

  readonly selected = computed<FormElement | null>(() => {
    const uuid = this.selectedUuidSignal();
    if (uuid === null) return null;
    return flattenElements(this.definition()).find((e) => e.uuid === uuid) ?? null;
  });

  /**
   * Problems that would stop this template being published.
   *
   * Checked continuously rather than only on publish, because a form author
   * discovering a duplicate key after twenty fields is worse than discovering
   * it at the moment they create it. The server checks again on publish and is
   * the authority.
   */
  readonly problems = computed<readonly BuilderProblem[]>(() => {
    const found: BuilderProblem[] = [];
    const elements = flattenElements(this.definition());

    if (elements.length === 0) {
      found.push({ severity: 'warning', message: 'The form has no fields yet' });
      return found;
    }

    // A duplicate jsonKey means two fields write the same submission value:
    // one silently overwrites the other.
    const seen = new Map<string, number>();
    for (const element of elements) {
      if (element.jsonKey === '') {
        found.push({
          severity: 'error',
          elementUuid: element.uuid,
          message: 'A field has no key. Its value would not be saved.',
        });
        continue;
      }
      seen.set(element.jsonKey, (seen.get(element.jsonKey) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      if (count > 1) {
        found.push({
          severity: 'error',
          message: `Key '${key}' is used by ${count} fields. Values would overwrite each other.`,
        });
      }
    }

    // A dependency on a field that does not exist never fires, which looks
    // like the rule being ignored.
    const keys = new Set(elements.map((e) => e.jsonKey));
    for (const element of elements) {
      for (const rule of element.dependsOn?.rules ?? []) {
        for (const condition of rule.conditions) {
          if (!keys.has(condition.field)) {
            found.push({
              severity: 'error',
              elementUuid: element.uuid,
              message: `A rule on '${element.jsonKey}' watches '${condition.field}', which does not exist.`,
            });
          }
        }
      }
    }

    // A circular formula reference is an infinite loop at render time.
    const formulas: Record<string, string> = {};
    for (const element of elements) {
      if (element.formula !== undefined && element.formula !== '' && element.jsonKey !== '') {
        formulas[element.jsonKey] = element.formula;
      }
    }
    try {
      const cycle = findCircularReferences(formulas);
      if (cycle.length > 0) {
        found.push({
          severity: 'error',
          message: `Circular formula reference between: ${cycle.join(', ')}`,
        });
      }
    } catch (error) {
      found.push({
        severity: 'error',
        message: `A formula will not parse: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      });
    }

    // A form with no submit button cannot be completed by anyone.
    const hasButton = elements.some((e) => e.fieldType === FieldType.BUTTON);
    if (!hasButton) {
      found.push({
        severity: 'warning',
        message: 'The form has no buttons. Add a Button Group so it can be submitted.',
      });
    }

    return found;
  });

  readonly hasErrors = computed(() => this.problems().some((p) => p.severity === 'error'));

  // ------------------------------------------------------------- mutations

  load(definition: FormDefinition): void {
    this.rootSignal.set(definition.root);
    this.history.set([]);
    this.selectedUuidSignal.set(null);
  }

  select(uuid: string | null): void {
    this.selectedUuidSignal.set(uuid);
  }

  /**
   * Add a field.
   *
   * Placed inside the selected container when there is one, otherwise at the
   * end of the root. Appending into whatever is selected is what an author
   * expects when they have just clicked a section.
   */
  add(fieldType: FieldType): void {
    const element = newElement(fieldType, this.nextKey(fieldType));
    const selected = this.selected();

    this.commit(
      selected !== null && isContainerType(selected.fieldType)
        ? mapTree(this.rootSignal(), (node) =>
            node.uuid === selected.uuid
              ? { ...node, children: [...(node.children ?? []), element] }
              : node,
          )
        : [...this.rootSignal(), element],
    );

    this.selectedUuidSignal.set(element.uuid);
  }

  update(uuid: string, changes: Partial<FormElement>): void {
    this.commit(
      mapTree(this.rootSignal(), (node) => (node.uuid === uuid ? { ...node, ...changes } : node)),
    );
  }

  remove(uuid: string): void {
    this.commit(removeFromTree(this.rootSignal(), uuid));
    if (this.selectedUuidSignal() === uuid) {
      this.selectedUuidSignal.set(null);
    }
  }

  /** Move a field up or down among its siblings. */
  move(uuid: string, direction: -1 | 1): void {
    this.commit(moveInTree(this.rootSignal(), uuid, direction));
  }

  undo(): void {
    const previous = this.history();
    if (previous.length === 0) return;
    this.rootSignal.set(previous[previous.length - 1]!);
    this.history.set(previous.slice(0, -1));
  }

  private commit(next: readonly FormElement[]): void {
    // Bounded: an editing session should not accumulate unbounded history.
    this.history.update((h) => [...h, this.rootSignal()].slice(-50));
    this.rootSignal.set(next);
  }

  /** A unique key like `textbox3`, so a new field is immediately valid. */
  private nextKey(fieldType: FieldType): string {
    const base = FieldType[fieldType].toLowerCase();
    const existing = new Set(flattenElements(this.definition()).map((e) => e.jsonKey));
    let index = 1;
    while (existing.has(`${base}${index}`)) index += 1;
    return `${base}${index}`;
  }
}

// ------------------------------------------------------------------ helpers

export function isContainerType(fieldType: FieldType): boolean {
  return CONTAINER_FIELD_TYPES.has(fieldType);
}

function newElement(fieldType: FieldType, jsonKey: string): FormElement {
  const base: FormElement = {
    uuid: `el-${Math.random().toString(36).slice(2, 10)}`,
    jsonKey,
    fieldType,
    displayKey: humanise(FieldType[fieldType]),
  };

  if (isContainerType(fieldType)) {
    return { ...base, children: [] };
  }

  // A choice field with no options renders as an empty dropdown, which looks
  // broken. Seed one so it is usable the moment it is added.
  if (
    fieldType === FieldType.DROPDOWN ||
    fieldType === FieldType.RADIOGROUP ||
    fieldType === FieldType.MULTISELECT
  ) {
    return { ...base, options: [{ label: 'Option 1', value: 'OPTION_1' }] };
  }

  return base;
}

function humanise(name: string): string {
  const lower = name.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Apply a transform to every node, preserving structure. */
function mapTree(
  elements: readonly FormElement[],
  transform: (element: FormElement) => FormElement,
): readonly FormElement[] {
  return elements.map((element) => {
    const mapped = transform(element);
    if (mapped.children === undefined) return mapped;
    return { ...mapped, children: mapTree(mapped.children, transform) };
  });
}

function removeFromTree(elements: readonly FormElement[], uuid: string): readonly FormElement[] {
  return elements
    .filter((element) => element.uuid !== uuid)
    .map((element) =>
      element.children === undefined
        ? element
        : { ...element, children: removeFromTree(element.children, uuid) },
    );
}

function moveInTree(
  elements: readonly FormElement[],
  uuid: string,
  direction: -1 | 1,
): readonly FormElement[] {
  const index = elements.findIndex((element) => element.uuid === uuid);

  if (index !== -1) {
    const target = index + direction;
    // Silently ignore a move off either end rather than wrapping: wrapping
    // would look like the field jumping to the far side of the form.
    if (target < 0 || target >= elements.length) return elements;
    const reordered = [...elements];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    return reordered;
  }

  return elements.map((element) =>
    element.children === undefined
      ? element
      : { ...element, children: moveInTree(element.children, uuid, direction) },
  );
}
