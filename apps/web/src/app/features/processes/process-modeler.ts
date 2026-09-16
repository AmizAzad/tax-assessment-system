import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import { AssessmentService } from '../../core/assessment.service';
import { AuthService } from '../../core/auth.service';
import type { BpmnValidation } from '../../core/domain';
import { FLOWABLE_MODDLE } from '../../shared/flowable-moddle';
import { ErrorAlert, describeError } from '../../shared/ui';

/** The roles a user task may be given. Matches the role catalogue. */
const ROLE_CODES = [
  'TA_ASSESSOR',
  'TA_SPECIALIST',
  'TA_REVIEWER',
  'TA_APPROVER_L1',
  'TA_APPROVER_L2',
  'TA_APPROVER_L3',
  'TA_SUPERVISOR',
  'TA_NOTICE_ISSUER',
  'TA_OBJECTION_OFFICER',
  'TA_APPEALS_OFFICER',
  'TA_COMMITTEE_MEMBER',
  'TA_ADMIN',
];

interface Selected {
  readonly id: string;
  readonly type: string;
  name: string;
  candidateGroups: string;
  stepCode: string;
  formId: string;
  delegateExpression: string;
  endpoint: string;
  method: string;
  outputVariable: string;
}

/**
 * Authoring a process definition.
 *
 * Plan reference: V2 section 18.1 screen 20, sections 5.2 and 5.3.
 *
 * ## Why the property panel is ours rather than the off-the-shelf one
 *
 * `bpmn-js-properties-panel` offers every property the engine understands.
 * Most of them this system refuses: a service task naming a Java class, an
 * execution listener, a script task. Offering fields that the publish-time
 * validator will reject teaches an author to fill them in and then fight the
 * deploy button.
 *
 * This panel offers exactly what a definition here may contain — candidate
 * groups, a step code, a form, and the `apiInvoker` fields — so the shape of
 * the panel is the shape of the contract.
 *
 * ## Why validation is the server's and not the panel's
 *
 * The panel could check that a user task has candidate groups. It does not
 * decide, because the API is what refuses a deployment, and a second copy of
 * the rule in a browser is a second copy that will drift. **Validate** sends
 * the definition to the same validator the deploy endpoint runs, and shows
 * what came back against the element ids.
 *
 * ## Why the delegate expression is fixed
 *
 * Every outbound call goes through `${apiInvoker}`, which carries an
 * idempotency key derived from the process instance and activity. A free-text
 * delegate would be a retry that double-applies something.
 */
@Component({
  selector: 'tas-process-modeler',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Process modeller</h1>
        <p class="tas-muted">
          The coordination of an assessment. It decides who is asked to act and in what order — the
          API still owns case status, and nothing here can change a status.
        </p>
      </div>
      <div class="tas-row">
        <button type="button" class="tas-btn" (click)="loadDeployed()">Load deployed</button>
        <button type="button" class="tas-btn" (click)="file.click()">Open file</button>
        <button type="button" class="tas-btn" (click)="download()">Save file</button>
        <button type="button" class="tas-btn" [disabled]="busy()" (click)="validate()">
          Validate
        </button>
        @if (canDeploy()) {
          <button
            type="button"
            class="tas-btn tas-btn--primary"
            [disabled]="busy()"
            (click)="deploy()"
          >
            Deploy
          </button>
        }
      </div>
    </div>

    <input #file type="file" accept=".bpmn,.xml" style="display:none" (change)="openFile($event)" />

    <tas-error [message]="error()" />

    @if (validation(); as result) {
      <div
        class="tas-alert"
        [class.tas-alert--danger]="!result.valid"
        role="status"
        aria-live="polite"
      >
        @if (result.valid) {
          <strong>This definition would be accepted.</strong>
          <p class="tas-muted">
            Every user task names a role, a step code and a form; every service task calls the
            apiInvoker delegate.
          </p>
        } @else {
          <strong>It would be refused:</strong>
          <ul>
            @for (problem of result.problems; track $index) {
              <li>
                @if (problem.elementId) {
                  <button type="button" class="tas-link" (click)="reveal(problem.elementId!)">
                    <code>{{ problem.elementId }}</code>
                  </button>
                  —
                }
                {{ problem.message }}
              </li>
            }
          </ul>
        }
      </div>
    }

    @if (deployed(); as result) {
      <div class="tas-alert" role="status">
        Deployed as <code>{{ result.processDefinitionKey }}</code> version {{ result.version }}.
        Cases opened from now on are coordinated by it; cases already running keep the definition
        they started under.
      </div>
    }

    <div class="tas-modeller">
      <div #canvas class="tas-modeller__canvas"></div>

      <aside class="tas-modeller__panel">
        @if (selected(); as element) {
          <h2>{{ shortType(element.type) }}</h2>
          <p class="tas-muted">
            <code>{{ element.id }}</code>
          </p>

          <div class="tas-field">
            <label [attr.for]="'p-name'">Name</label>
            <input id="p-name" [ngModel]="element.name" (ngModelChange)="setName($event)" />
          </div>

          @if (isUserTask()) {
            <p class="tas-muted">
              A user task with no role is claimable by anyone, and one with no step code cannot be
              correlated with the transition table. The API refuses both at deployment.
            </p>

            <fieldset class="tas-field">
              <legend>Roles that may claim it</legend>
              @for (role of roles; track role) {
                <label class="tas-check">
                  <input
                    type="checkbox"
                    [checked]="hasRole(role)"
                    (change)="toggleRole(role, $any($event.target).checked)"
                  />
                  {{ role }}
                </label>
              }
            </fieldset>

            <div class="tas-field">
              <label for="p-step">Step code</label>
              <input
                id="p-step"
                [ngModel]="element.stepCode"
                (ngModelChange)="setProperty('stepCode', $event)"
                placeholder="PREPARE"
              />
            </div>

            <div class="tas-field">
              <label for="p-form">Form</label>
              <input
                id="p-form"
                [ngModel]="element.formId"
                (ngModelChange)="setProperty('formId', $event)"
                placeholder="TA-04-PREPARATION"
              />
            </div>
          }

          @if (isServiceTask()) {
            <p class="tas-muted">
              Every outbound call goes through the one delegate, which carries an idempotency key
              derived from the process instance and activity. That is what makes a retry safe.
            </p>

            <div class="tas-field">
              <label for="p-delegate">Delegate</label>
              <input id="p-delegate" [value]="element.delegateExpression" readonly />
            </div>

            <div class="tas-field">
              <label for="p-method">Method</label>
              <select
                id="p-method"
                [ngModel]="element.method"
                (ngModelChange)="setField('method', $event, false)"
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </div>

            <div class="tas-field">
              <label for="p-endpoint">Endpoint</label>
              <input
                id="p-endpoint"
                [ngModel]="element.endpoint"
                (ngModelChange)="setField('endpoint', $event, true)"
                placeholder="/api/v1/cases/&#36;&#123;caseId&#125;/transition"
              />
              <small class="tas-muted">
                Written as an expression, so <code>&#36;&#123;caseId&#125;</code> is substituted. As
                a literal string it would be sent verbatim.
              </small>
            </div>

            <div class="tas-field">
              <label for="p-output">Output variable</label>
              <input
                id="p-output"
                [ngModel]="element.outputVariable"
                (ngModelChange)="setField('outputVariable', $event, false)"
                placeholder="evidence"
              />
            </div>
          }
        } @else {
          <h2>Nothing selected</h2>
          <p class="tas-muted">
            Select a task on the diagram to edit what it does and who it belongs to.
          </p>
        }
      </aside>
    </div>
  `,
  styles: [
    `
      .tas-modeller {
        display: grid;
        grid-template-columns: 1fr 320px;
        gap: 1rem;
        align-items: start;
      }
      .tas-modeller__canvas {
        height: 70vh;
        border: 1px solid var(--tas-border, #e2e8f0);
        border-radius: 6px;
        background: #fff;
      }
      .tas-modeller__panel {
        border: 1px solid var(--tas-border, #e2e8f0);
        border-radius: 6px;
        background: var(--tas-surface, #fff);
        padding: 1rem;
      }
      .tas-modeller__panel h2 {
        margin-top: 0;
        font-size: 1rem;
      }
      .tas-check {
        display: block;
        font-size: 0.85rem;
        font-weight: 400;
      }
      .tas-link {
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        color: #2563eb;
        cursor: pointer;
        text-decoration: underline;
      }
      @media (max-width: 900px) {
        .tas-modeller {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class ProcessModeler implements AfterViewInit, OnDestroy {
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);

  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLElement>;

  readonly roles = ROLE_CODES;
  readonly selected = signal<Selected | null>(null);
  readonly validation = signal<BpmnValidation | null>(null);
  readonly deployed = signal<{ processDefinitionKey: string; version: number } | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  readonly isUserTask = computed(() => this.selected()?.type === 'bpmn:UserTask');
  readonly isServiceTask = computed(() => this.selected()?.type === 'bpmn:ServiceTask');

  private modeler: BpmnModeler | null = null;

  async ngAfterViewInit(): Promise<void> {
    this.modeler = new BpmnModeler({
      container: this.canvasRef.nativeElement,
      moddleExtensions: { flowable: FLOWABLE_MODDLE },
    });

    const eventBus = this.modeler.get('eventBus') as {
      on: (event: string, handler: (payload: { element?: unknown }) => void) => void;
    };
    eventBus.on('selection.changed', () => this.readSelection());
    eventBus.on('element.changed', () => this.readSelection());

    await this.loadDeployed();
  }

  ngOnDestroy(): void {
    this.modeler?.destroy();
    this.modeler = null;
  }

  canDeploy(): boolean {
    return this.auth.canInvoke('POST', '/api/v1/processes/deploy');
  }

  shortType(type: string): string {
    return type.replace('bpmn:', '').replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  /** Open the definition currently registered, so an edit starts from truth. */
  async loadDeployed(): Promise<void> {
    this.error.set(null);
    try {
      const definition = await this.assessment.processDefinition('TAX_ASSESSMENT_MAIN');
      await this.importXml(definition.bpmnXml);
    } catch (error) {
      // A deployment that has never happened is not an error worth a red box
      // on an authoring screen; it just means starting from a blank diagram.
      this.error.set(describeError(error));
      await this.importXml(BLANK_DIAGRAM);
    }
  }

  async openFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file === undefined) {
      return;
    }
    await this.importXml(await file.text());
    // Cleared so that choosing the same file again still fires a change.
    input.value = '';
  }

  /** Hand the current diagram to the browser as a file. */
  async download(): Promise<void> {
    const xml = await this.currentXml();
    if (xml === null) {
      return;
    }
    const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'TAX_ASSESSMENT_MAIN.bpmn20.xml';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  /** Ask the server whether this definition would be accepted. */
  async validate(): Promise<void> {
    const xml = await this.currentXml();
    if (xml === null) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.deployed.set(null);
    try {
      this.validation.set(await this.assessment.validateProcess('TAX_ASSESSMENT_MAIN', xml));
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Deploy.
   *
   * Validated on the server first regardless of what this screen last showed:
   * the diagram may have been edited since, and the check that matters is the
   * one the deploy endpoint runs.
   */
  async deploy(): Promise<void> {
    const xml = await this.currentXml();
    if (xml === null) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await this.assessment.deployProcess('TAX_ASSESSMENT_MAIN', xml);
      this.deployed.set(result);
      this.validation.set({ valid: true, problems: [] });
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Select and centre the element a validation problem names. */
  reveal(elementId: string): void {
    if (this.modeler === null) {
      return;
    }
    const registry = this.modeler.get('elementRegistry') as {
      get: (id: string) => unknown;
    };
    const element = registry.get(elementId);
    if (element === undefined || element === null) {
      return;
    }
    const selection = this.modeler.get('selection') as { select: (element: unknown) => void };
    const canvas = this.modeler.get('canvas') as { scrollToElement: (element: unknown) => void };
    selection.select(element);
    canvas.scrollToElement(element);
  }

  // ------------------------------------------------------------ editing

  setName(name: string): void {
    this.update({ name });
  }

  hasRole(role: string): boolean {
    const groups = this.selected()?.candidateGroups ?? '';
    return groups.split(',').includes(role);
  }

  /**
   * Add or remove a role.
   *
   * `candidateGroups` and the `roles` property are written together: the
   * engine reads the first to decide who may claim the task, and the API
   * reads the second when it records who a task belongs to. Letting them
   * diverge would give an inbox that disagrees with the engine.
   */
  toggleRole(role: string, checked: boolean): void {
    const current = (this.selected()?.candidateGroups ?? '').split(',').filter(Boolean);
    const next = checked ? [...new Set([...current, role])] : current.filter((r) => r !== role);
    const value = next.join(',');
    this.update({ candidateGroups: value });
    this.writeProperty('roles', value);
  }

  setProperty(name: 'stepCode' | 'formId', value: string): void {
    this.writeProperty(name, value);
  }

  /** Write a delegate field, as a literal or as an expression. */
  setField(name: string, value: string, asExpression: boolean): void {
    const element = this.currentElement();
    if (element === null || this.modeler === null) {
      return;
    }

    const moddle = this.modeler.get('moddle') as {
      create: (type: string, attrs?: Record<string, unknown>) => Record<string, unknown>;
    };
    const modeling = this.modeler.get('modeling') as {
      updateModdleProperties: (element: unknown, target: unknown, properties: unknown) => void;
    };

    const businessObject = (element as { businessObject: Record<string, unknown> }).businessObject;
    const extensions = this.ensureExtensions(businessObject, moddle, modeling, element);
    const values = (extensions['values'] as Record<string, unknown>[]) ?? [];

    const existing = values.find(
      (entry) => entry['$type'] === 'flowable:Field' && entry['name'] === name,
    );

    const field =
      existing ?? (moddle.create('flowable:Field', { name }) as unknown as Record<string, unknown>);

    // One or the other, never both: a field carrying a string and an
    // expression is ambiguous and the engine picks for you.
    field['string'] = asExpression ? undefined : value;
    field['expression'] = asExpression ? value : undefined;

    modeling.updateModdleProperties(element, extensions, {
      values: existing === undefined ? [...values, field] : values,
    });

    this.readSelection();
  }

  // ------------------------------------------------------------ internals

  private async importXml(xml: string): Promise<void> {
    if (this.modeler === null) {
      return;
    }
    try {
      // Definitions loaded from the API already carry coordinates: the server
      // lays out anything authored without them. A file opened from disk may
      // not, in which case bpmn-js reports it and the message below says so
      // rather than showing an empty canvas.
      await this.modeler.importXML(xml);
      (this.modeler.get('canvas') as { zoom: (mode: string) => void }).zoom('fit-viewport');
      this.validation.set(null);
      this.deployed.set(null);
    } catch (error) {
      this.error.set(
        `That file could not be opened as BPMN: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  private async currentXml(): Promise<string | null> {
    if (this.modeler === null) {
      return null;
    }
    try {
      const { xml } = await this.modeler.saveXML({ format: true });
      return xml ?? null;
    } catch (error) {
      this.error.set(describeError(error));
      return null;
    }
  }

  private currentElement(): unknown | null {
    if (this.modeler === null) {
      return null;
    }
    const selection = this.modeler.get('selection') as { get: () => unknown[] };
    return selection.get()[0] ?? null;
  }

  private update(properties: Record<string, unknown>): void {
    const element = this.currentElement();
    if (element === null || this.modeler === null) {
      return;
    }
    const modeling = this.modeler.get('modeling') as {
      updateProperties: (element: unknown, properties: Record<string, unknown>) => void;
    };
    modeling.updateProperties(element, properties);
    this.readSelection();
  }

  private writeProperty(name: string, value: string): void {
    const element = this.currentElement();
    if (element === null || this.modeler === null) {
      return;
    }

    const moddle = this.modeler.get('moddle') as {
      create: (type: string, attrs?: Record<string, unknown>) => Record<string, unknown>;
    };
    const modeling = this.modeler.get('modeling') as {
      updateModdleProperties: (element: unknown, target: unknown, properties: unknown) => void;
    };

    const businessObject = (element as { businessObject: Record<string, unknown> }).businessObject;
    const extensions = this.ensureExtensions(businessObject, moddle, modeling, element);
    const values = (extensions['values'] as Record<string, unknown>[]) ?? [];

    let container = values.find((entry) => entry['$type'] === 'flowable:Properties');
    if (container === undefined) {
      container = moddle.create('flowable:Properties', { values: [] }) as unknown as Record<
        string,
        unknown
      >;
      modeling.updateModdleProperties(element, extensions, { values: [...values, container] });
    }

    const entries = (container['values'] as Record<string, unknown>[]) ?? [];
    const existing = entries.find((entry) => entry['name'] === name);

    if (existing !== undefined) {
      modeling.updateModdleProperties(element, existing, { value });
    } else {
      const property = moddle.create('flowable:Property', { name, value });
      modeling.updateModdleProperties(element, container, { values: [...entries, property] });
    }

    this.readSelection();
  }

  private ensureExtensions(
    businessObject: Record<string, unknown>,
    moddle: { create: (type: string, attrs?: Record<string, unknown>) => Record<string, unknown> },
    modeling: {
      updateModdleProperties: (element: unknown, target: unknown, properties: unknown) => void;
    },
    element: unknown,
  ): Record<string, unknown> {
    const existing = businessObject['extensionElements'] as Record<string, unknown> | undefined;
    if (existing !== undefined) {
      return existing;
    }
    const created = moddle.create('bpmn:ExtensionElements', { values: [] });
    modeling.updateModdleProperties(element, businessObject, { extensionElements: created });
    return created;
  }

  /** Read the selected element into the panel's flat shape. */
  private readSelection(): void {
    const element = this.currentElement();
    if (element === null) {
      this.selected.set(null);
      return;
    }

    const typed = element as { id: string; type: string; businessObject: Record<string, unknown> };
    const businessObject = typed.businessObject;
    const extensions = businessObject['extensionElements'] as
      { values?: Record<string, unknown>[] } | undefined;
    const values = extensions?.values ?? [];

    const properties =
      (values.find((entry) => entry['$type'] === 'flowable:Properties')?.['values'] as
        Record<string, unknown>[] | undefined) ?? [];

    const propertyValue = (name: string): string =>
      String(properties.find((entry) => entry['name'] === name)?.['value'] ?? '');

    const fieldValue = (name: string): string => {
      const field = values.find(
        (entry) => entry['$type'] === 'flowable:Field' && entry['name'] === name,
      );
      if (field === undefined) {
        return '';
      }
      return String(field['expression'] ?? field['string'] ?? '');
    };

    this.selected.set({
      id: typed.id,
      type: typed.type,
      name: String(businessObject['name'] ?? ''),
      candidateGroups: String(businessObject['candidateGroups'] ?? ''),
      stepCode: propertyValue('stepCode'),
      formId: propertyValue('formId'),
      // Fixed, and shown read-only. See the class note.
      delegateExpression: String(businessObject['delegateExpression'] ?? '${apiInvoker}'),
      endpoint: fieldValue('endpoint'),
      method: fieldValue('method') || 'POST',
      outputVariable: fieldValue('outputVariable'),
    });
  }
}

/** A diagram to start from when nothing is deployed yet. */
const BLANK_DIAGRAM = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:flowable="http://flowable.org/bpmn"
                  targetNamespace="http://iris.com/taxassessment">
  <bpmn:process id="TAX_ASSESSMENT_MAIN" name="Tax Assessment" isExecutable="true">
    <bpmn:startEvent id="start" name="Case opened" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="diagram">
    <bpmndi:BPMNPlane id="plane" bpmnElement="TAX_ASSESSMENT_MAIN">
      <bpmndi:BPMNShape id="start_di" bpmnElement="start">
        <dc:Bounds x="160" y="160" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;
