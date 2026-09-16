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
import { DatePipe } from '@angular/common';
import { AssessmentService } from '../../../core/assessment.service';
import type { EvidenceSnapshot } from '../../../core/domain';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../../shared/ui';

/**
 * The evidence snapshot a case is assessed on.
 *
 * Plan reference: V2 sections 8.2 to 8.5.
 *
 * ## Why the provider outcomes are shown so prominently
 *
 * A failed mandatory source is the difference between an assessment that is
 * complete and one that merely looks complete. The panel therefore shows every
 * provider and its outcome, not just the figures that arrived: an officer must
 * be able to see that the account feed was unreachable, because the figures on
 * screen would otherwise be indistinguishable from a taxpayer who genuinely
 * had no payments.
 */
@Component({
  selector: 'tas-case-evidence',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <div class="tas-page-head" style="margin-block-end:0.5rem">
        <div>
          <h2 style="margin:0">Evidence</h2>
          <p class="tas-muted" style="margin:0.25rem 0 0">
            Frozen once the case is submitted for review, so the reviewer decides on the facts the
            assessment was prepared from.
          </p>
        </div>
        <button
          type="button"
          class="tas-btn tas-btn--primary"
          [disabled]="busy()"
          (click)="refresh()"
        >
          {{ busy() ? 'Retrieving…' : 'Retrieve evidence' }}
        </button>
      </div>

      @if (lastRun(); as run) {
        <div
          class="tas-alert"
          [class.tas-alert--danger]="!run.dataReady"
          style="margin-block-start:1rem"
        >
          <strong>{{ run.dataReady ? 'Data ready' : 'Case not advanced' }}</strong>
          — {{ run.itemsWritten }} declared item(s) recorded; case is {{ run.statusCode }}.
          <table class="tas-table" style="margin-block-start:0.75rem">
            <thead>
              <tr>
                <th>Source</th>
                <th>Required</th>
                <th>Outcome</th>
                <th>Items</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              @for (p of run.providers; track p.providerCode) {
                <tr>
                  <td>
                    <code>{{ p.providerCode }}</code>
                  </td>
                  <td>{{ p.mandatory ? 'Mandatory' : 'Optional' }}</td>
                  <td><tas-status [status]="p.status" /></td>
                  <td>{{ p.itemCount }}</td>
                  <td class="tas-muted">{{ p.failureReason ?? '' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    @if (snapshot(); as s) {
      <div class="tas-card" style="margin-block-start:1rem">
        <h3>Declared figures</h3>
        <p class="tas-muted">
          Mapped from the filed return by the tax concept on each form field. A field with no
          concept is context for a caseworker, not an input to the assessment.
        </p>
        @if (s.items.length === 0) {
          <tas-empty>Nothing was declared. That is a non-filer assessment, not an error.</tas-empty>
        } @else {
          <table class="tas-table">
            <thead>
              <tr>
                <th>Concept</th>
                <th>Source</th>
                <th style="text-align:end">Declared</th>
              </tr>
            </thead>
            <tbody>
              @for (item of s.items; track item.concept_code) {
                <tr>
                  <td>
                    <code>{{ item.concept_code }}</code>
                    @if (item.item_label_key) {
                      <div class="tas-muted" style="font-size:0.8rem">
                        {{ item.item_label_key }}
                      </div>
                    }
                  </td>
                  <td>{{ item.source }}</td>
                  <td class="tas-amount">{{ item.declared_amount | tasAmount }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>

      <div class="tas-card" style="margin-block-start:1rem">
        <h3>Sources and hashes</h3>
        <p class="tas-muted">
          Each retrieval is hashed so the facts a decision rested on can be shown to be unchanged.
        </p>
        <table class="tas-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Retrieved</th>
              <th>Content hash</th>
            </tr>
          </thead>
          <tbody>
            @for (source of s.sources; track source.source_system) {
              <tr>
                <td>
                  <code>{{ source.source_system }}</code>
                </td>
                <td>{{ source.retrieved_at | date: 'yyyy-MM-dd HH:mm' }}</td>
                <td>
                  <code style="font-size:0.75rem">{{ source.payload_hash.slice(0, 24) }}…</code>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else if (!loading() && !error()) {
      <div class="tas-card" style="margin-block-start:1rem">
        <tas-empty>
          No evidence has been retrieved yet. Retrieving it is what moves the case to data-ready.
        </tas-empty>
      </div>
    }
  `,
})
export class CaseEvidence implements OnInit {
  private readonly assessment = inject(AssessmentService);

  @Input({ required: true }) caseId!: number;
  @Input() status = '';
  @Output() readonly changed = new EventEmitter<void>();

  readonly snapshot = signal<EvidenceSnapshot | null>(null);
  readonly lastRun = signal<Awaited<ReturnType<AssessmentService['refreshEvidence']>> | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly loading = signal(false);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.snapshot.set(await this.assessment.evidence(this.caseId));
    } catch {
      // A 404 here is the normal state of a new case, not a failure worth
      // showing: the empty state below says it better.
      this.snapshot.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  async refresh(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.lastRun.set(await this.assessment.refreshEvidence(this.caseId));
      await this.load();
      this.changed.emit();
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }
}
