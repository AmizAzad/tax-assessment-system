import { Component, ChangeDetectionStrategy, computed, inject, signal } from '@angular/core';
import { FieldType, type FormDefinition, type FormValues } from '@tas/dynaforms-core';
import { AuthService } from '../../core/auth.service';
import { FormRenderer, type FormSubmitEvent } from '../../dynaforms/form-renderer';

/**
 * A live demonstration of the form renderer.
 *
 * Plan reference: V2 sections 4.1, 11.3, 18.2; ADR-005, ADR-006.
 *
 * The definition below is a cut-down TA-06 Adjustment form. It is here rather
 * than loaded from the API because the point is to exercise the engine
 * behaviours that are otherwise invisible until Phase 2 provides real
 * templates:
 *
 *   - a dependency that shows and requires a field
 *   - an option list narrowed by another field's value
 *   - a conditionally mandatory narrative
 *   - a computed field that is read-only and server-owned
 *   - validation the server runs identically (ADR-005)
 *
 * Everything it renders comes from the definition. There is no form-specific
 * markup anywhere in this component, which is the discipline plan 18.2
 * requires.
 */
@Component({
  selector: 'tas-form-preview',
  standalone: true,
  imports: [FormRenderer],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Form renderer</h1>
    <p class="tas-muted">
      A cut-down TA-06 Adjustment form. Everything below is rendered from a JSON definition running
      the same dependency and validation engines the API uses.
    </p>

    <div class="tas-preview">
      <div class="tas-card">
        <tas-form-renderer
          [definition]="definition"
          [roleCodes]="roleCodes()"
          (submitted)="onSubmit($event)"
          (valueChanged)="onChange($event)"
        />
      </div>

      <aside class="tas-card tas-preview__side">
        <h2>Try this</h2>
        <ol>
          <li>
            Set <strong>Adjustment type</strong> to <em>Statutory disallowance</em> — a statutory
            reference field appears and becomes mandatory.
          </li>
          <li>Open <strong>Reason code</strong> — the list is now narrowed to one option.</li>
          <li>
            Enter an assessed amount different from the declared one — the difference computes, and
            the narrative becomes mandatory.
          </li>
          <li>
            Press <strong>Submit</strong> with something missing — the same validation the server
            would apply.
          </li>
        </ol>

        <h2>Current values</h2>
        <pre class="tas-preview__json">{{ valuesJson() }}</pre>

        @if (lastSubmit(); as submit) {
          <h2>Last submit</h2>
          <p>
            <code>{{ submit.actionCode }}</code> accepted by the client.
          </p>
          <p class="tas-muted">
            The server would validate this again and is the authority. Persisting it needs the case
            context that arrives in Phase 2.
          </p>
        }
      </aside>
    </div>
  `,
  styles: [
    `
      .tas-preview {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 340px;
        gap: 1.25rem;
        align-items: start;
        margin-top: 1rem;
      }
      @media (max-width: 900px) {
        .tas-preview {
          grid-template-columns: 1fr;
        }
      }
      .tas-preview__side {
        font-size: 0.875rem;
        position: sticky;
        top: 1rem;
      }
      .tas-preview__json {
        background: var(--tas-surface-muted);
        padding: 0.75rem;
        border-radius: 4px;
        font-size: 0.75rem;
        overflow-x: auto;
        max-height: 240px;
      }
      ol {
        padding-inline-start: 1.2rem;
      }
    `,
  ],
})
export class FormPreview {
  private readonly auth = inject(AuthService);

  readonly roleCodes = computed(() => this.auth.roleCodes());
  readonly values = signal<FormValues>({});
  readonly lastSubmit = signal<FormSubmitEvent | null>(null);

  readonly valuesJson = computed(() => JSON.stringify(this.values(), null, 2));

  readonly definition: FormDefinition = {
    schemaVersion: '1.0.0',
    root: [
      {
        uuid: 'sec-1',
        jsonKey: 'adjustmentSection',
        fieldType: FieldType.SECTION,
        displayKey: 'Adjustment',
        children: [
          {
            uuid: 'f-type',
            jsonKey: 'adjustmentType',
            fieldType: FieldType.DROPDOWN,
            displayKey: 'Adjustment type',
            required: true,
            options: [
              { label: 'Statutory disallowance', value: 'STATUTORY_DISALLOWANCE' },
              { label: 'Understated revenue', value: 'UNDERSTATED_REVENUE' },
              { label: 'Timing difference', value: 'TIMING_DIFFERENCE' },
            ],
          },
          {
            uuid: 'f-reason',
            jsonKey: 'reasonCode',
            fieldType: FieldType.DROPDOWN,
            displayKey: 'Reason code',
            required: true,
            options: [
              { label: 'No supporting evidence', value: 'NO_SUPPORTING_EVIDENCE' },
              { label: 'Capital in nature', value: 'CAPITAL_IN_NATURE' },
              { label: 'Arithmetic error', value: 'ARITHMETIC_ERROR' },
            ],
            // Only one reason is defensible for a statutory disallowance.
            dependsOn: {
              rules: [
                {
                  conditions: [
                    { field: 'adjustmentType', operator: 'eq', value: 'STATUTORY_DISALLOWANCE' },
                  ],
                  effects: [{ type: 'filterOptions', allowedValues: ['CAPITAL_IN_NATURE'] }],
                },
              ],
            },
          },
          {
            uuid: 'f-statref',
            jsonKey: 'statutoryReference',
            fieldType: FieldType.TEXTBOX,
            displayKey: 'Statutory reference',
            hidden: true,
            clearOnHide: true,
            dependsOn: {
              rules: [
                {
                  conditions: [
                    { field: 'adjustmentType', operator: 'eq', value: 'STATUTORY_DISALLOWANCE' },
                  ],
                  effects: [
                    { type: 'setVisibility', value: true },
                    { type: 'setRequired', value: true },
                  ],
                },
              ],
            },
          },
          {
            uuid: 'f-declared',
            jsonKey: 'declaredAmount',
            fieldType: FieldType.NUMBER,
            displayKey: 'Declared amount',
            currency: 'GBP',
            // From the evidence snapshot. A caller must not restate what the
            // taxpayer declared, and the API rejects a change (ADR-006).
            source: 'server',
          },
          {
            uuid: 'f-assessed',
            jsonKey: 'assessedAmount',
            fieldType: FieldType.NUMBER,
            displayKey: 'Assessed amount',
            currency: 'GBP',
            required: true,
            min: 0,
            validationRules: [
              {
                uuid: 'v-1',
                formula: '@assessedAmount >= 0',
                errorKey: 'An assessed amount cannot be negative',
              },
            ],
          },
          {
            uuid: 'f-diff',
            jsonKey: 'differenceAmount',
            fieldType: FieldType.FORMULA,
            displayKey: 'Difference',
            currency: 'GBP',
            formula: '@assessedAmount - @declaredAmount',
            // Indicative on screen; the legal figure is computed server-side
            // in exact decimal with a stored trace (ADR-006, ADR-007).
            source: 'server',
          },
          {
            uuid: 'f-narrative',
            jsonKey: 'narrative',
            fieldType: FieldType.TEXTAREA,
            displayKey: 'Narrative',
            minLength: 10,
            dependsOn: {
              rules: [
                {
                  conditions: [{ field: 'differenceAmount', operator: 'neq', value: 0 }],
                  effects: [{ type: 'setRequired', value: true }],
                },
              ],
            },
          },
          {
            uuid: 'f-opinion',
            jsonKey: 'officerOpinion',
            fieldType: FieldType.TEXTAREA,
            displayKey: 'Officer opinion',
            // A reviewer reads this; they do not rewrite it. Enforced
            // server-side on submit as well (plan 9.4).
            readOnlyForRoles: ['TA_REVIEWER', 'TA_APPROVER_L1'],
          },
        ],
      },
      {
        uuid: 'grp-actions',
        jsonKey: 'actions',
        fieldType: FieldType.BUTTONGROUP,
        children: [
          {
            uuid: 'btn-draft',
            jsonKey: 'save_draft',
            fieldType: FieldType.BUTTON,
            displayKey: 'Save draft',
          },
          {
            uuid: 'btn-submit',
            jsonKey: 'submit',
            fieldType: FieldType.BUTTON,
            displayKey: 'Submit',
          },
        ],
      },
    ],
  };

  onChange(values: FormValues): void {
    this.values.set(values);
  }

  onSubmit(event: FormSubmitEvent): void {
    this.lastSubmit.set(event);
    this.values.set(event.values);
  }
}
