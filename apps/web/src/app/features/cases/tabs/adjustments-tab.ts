import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { AssessmentService } from '../../../core/assessment.service';
import { AuthService } from '../../../core/auth.service';
import { DraftStore } from '../../../core/draft-store';
import type { Adjustment } from '../../../core/domain';
import { FormRenderer, type FormSubmitEvent } from '../../../dynaforms/form-renderer';
import { canRework, isUnderDecision } from './case-rules';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../../shared/ui';
import type { FormDefinition, FormValues } from '@tas/dynaforms-core';

/**
 * Adjustments: the changes from declared to assessed.
 *
 * Plan reference: V2 sections 8.2 stage 4, 11.3, 18.2.
 *
 * ## The form is configuration, not markup
 *
 * The working area is the DynaForms renderer, rendering the published
 * `TA-06-ADJUSTMENT` template (plan 18.2). This tab knows that an adjustment
 * has a type, a reason, an amount, a direction and a narrative only because
 * it maps those keys onto the API; it does not decide which fields exist, in
 * what order, or which values the dropdowns offer.
 *
 * That is the rule V1's failure produced: a hand-written assessment form
 * becomes a component nobody can configure for the next jurisdiction. A
 * deployment that needs an extra reason code edits the template.
 *
 * ## The amount is still text on the wire
 *
 * The renderer draws a `NUMBER` field as `type="text"`, and the value is sent
 * as the string the officer typed. A `type="number"` input hands JavaScript a
 * double, and a double cannot hold every decimal a tax figure needs
 * (ADR-007). The API refuses JSON numbers for the same reason.
 *
 * ## Direction rather than a sign
 *
 * The amount is always positive and the direction says which way it moves the
 * base. A signed field invites a minus sign that means "deduct" in one row and
 * "a negative addition" in the next, and the two read identically afterwards.
 */
@Component({
  selector: 'tas-case-adjustments',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormRenderer, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    @if (canRecord && canRework(status)) {
      <div class="tas-card">
        <h2 style="margin-top:0">Record an adjustment</h2>
        <p class="tas-muted">
          Every adjustment moves the assessed figure away from what the taxpayer declared, so each
          one needs a reason a reviewer can follow. Amounts are in
          {{ currency || 'the case currency' }}.
        </p>

        @if (restoredAt(); as savedAt) {
          <div class="tas-alert" role="status">
            <span>
              Unsent work from {{ savedAt }} has been put back in this form. It was held in this
              browser on this machine only — nothing was recorded against the case.
            </span>
            <button type="button" class="tas-btn" (click)="discardDraft()">Discard it</button>
          </div>
        }

        @if (!drafts.online()) {
          <div class="tas-alert tas-alert--danger" role="alert">
            This browser is offline. Keep typing — what you write is held here, and can be sent when
            the connection returns.
          </div>
        }

        @if (definition(); as form) {
          <tas-form-renderer
            [definition]="form"
            [roleCodes]="roleCodes()"
            [draftKey]="draftKey()"
            [readOnly]="busy()"
            (submitted)="onSubmit($event)"
            (draftRestored)="restoredAt.set($event.toLocaleString())"
          />
        } @else if (formError(); as message) {
          <div class="tas-alert tas-alert--danger" role="alert">
            <strong>The adjustment form is not available.</strong>
            <p>{{ message }}</p>
            <p class="tas-alert__hint">
              The form is configuration: <code>TA-06-ADJUSTMENT</code> must be published before
              adjustments can be recorded.
            </p>
          </div>
        } @else {
          <p class="tas-muted">Loading the form…</p>
        }
      </div>
    } @else if (canRecord) {
      <div class="tas-card">
        <h2 style="margin-top:0">Adjustments</h2>
        <p class="tas-muted" style="margin:0">
          @if (isUnderDecision(status)) {
            The figures are in front of the reviewer or approver, so they are not changed under
            them. A change goes back through Return for rework and is reviewed again.
          } @else {
            The figures are the legal determination from finalisation onwards, so nothing more is
            recorded here. A change now goes through a reassessment.
          }
        </p>
      </div>
    }

    <div class="tas-card" [style.margin-block-start]="canRecord ? '1rem' : null">
      <h3 style="margin-top:0">Adjustments on this case</h3>
      @if (rows().length === 0) {
        <tas-empty>
          None recorded. The assessment currently rests entirely on the declared figures.
        </tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Reason</th>
              <th>Direction</th>
              <th class="tas-amount">Amount</th>
              <th>Status</th>
              <th>Narrative</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.id) {
              <tr>
                <td>
                  <code>{{ row.adjustmentType }}</code>
                </td>
                <td>
                  <code>{{ row.reasonCode }}</code>
                </td>
                <td>{{ row.direction === 'ADD' ? 'Add' : 'Deduct' }}</td>
                <td class="tas-amount">{{ row.amount | tasAmount }}</td>
                <td><tas-status [status]="row.status" /></td>
                <td class="tas-muted">{{ row.narrative ?? '—' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class CaseAdjustments implements OnInit {
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);
  /** Autosave. Read by the template to show the offline state. */
  protected readonly drafts = inject(DraftStore);

  @Input({ required: true }) caseId!: number;
  @Input() status = '';
  @Input() currency = '';
  /** Whether the caller holds the route that records one. */
  @Input() canRecord = false;
  @Output() readonly changed = new EventEmitter<void>();

  readonly rows = signal<readonly Adjustment[]>([]);
  readonly definition = signal<FormDefinition | null>(null);
  readonly formError = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  /** When the restored draft was written, or null if nothing was restored. */
  readonly restoredAt = signal<string | null>(null);

  readonly canRework = canRework;
  readonly isUnderDecision = isUnderDecision;

  roleCodes(): readonly string[] {
    return this.auth.caller()?.roleCodes ?? [];
  }

  /** Per case, so work on one case is never offered back on another. */
  draftKey(): string {
    return `adjustment.${this.caseId}`;
  }

  async ngOnInit(): Promise<void> {
    // The template is fetched only for someone who may use it: a role that
    // reads adjustments but cannot record one would otherwise make a request
    // for a form it is never shown.
    await Promise.all([this.canRecord ? this.loadForm() : undefined, this.load()]);
  }

  async load(): Promise<void> {
    try {
      this.rows.set(await this.assessment.adjustments(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  /**
   * Record what the renderer submitted.
   *
   * The action code comes from the form's button group, so the template
   * decides what is offered and this method decides what it means. Anything
   * other than the record action is ignored rather than guessed at.
   */
  async onSubmit(event: FormSubmitEvent): Promise<void> {
    if (event.actionCode !== 'RECORD') {
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.assessment.addAdjustment(this.caseId, {
        adjustmentType: text(event.values, 'adjustmentType'),
        reasonCode: text(event.values, 'reasonCode'),
        // Sent exactly as typed. Nothing here parses, rounds or reformats it.
        amount: text(event.values, 'amount'),
        direction: text(event.values, 'direction') === 'DEDUCT' ? 'DEDUCT' : 'ADD',
        narrative: text(event.values, 'narrative') || undefined,
      });

      // Accepted by the server, so the held copy is no longer needed and the
      // form starts clean for the next adjustment.
      this.drafts.clear(this.draftKey());
      this.restoredAt.set(null);
      await this.loadForm();
      await this.load();
      this.changed.emit();
    } catch (error) {
      // The draft stays. A refused submission is something to correct, not
      // something to retype.
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  discardDraft(): void {
    this.drafts.clear(this.draftKey());
    this.restoredAt.set(null);
    void this.loadForm();
  }

  /**
   * Fetch the published template.
   *
   * Re-fetched after a successful submission, which is also how the form is
   * reset: a new renderer instance starts from the initial values instead of
   * keeping the last adjustment's figures in the boxes.
   */
  private async loadForm(): Promise<void> {
    this.definition.set(null);
    try {
      const template = await this.assessment.publishedTemplate('TA-06-ADJUSTMENT');
      this.definition.set(template.definition);
      this.formError.set(null);
    } catch (error) {
      this.formError.set(describeError(error));
    }
  }
}

/** A submitted value as the string the API expects. Never parsed. */
function text(values: FormValues, key: string): string {
  const value = values[key];
  return value === null || value === undefined ? '' : String(value);
}
