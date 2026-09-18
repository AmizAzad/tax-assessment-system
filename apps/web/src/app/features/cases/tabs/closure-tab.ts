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
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AssessmentService } from '../../../core/assessment.service';
import type { ClosureRecord, LineageEntry } from '../../../core/domain';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../../shared/ui';

/**
 * The settlement position the server returns alongside a recorded payment.
 *
 * Mirrors `SettlementOutcome` in the API's settlement service. Declared here
 * because the account endpoint is typed `Record<string, unknown>`, and this is
 * the only place the shape is read.
 */
interface SettlementPosition {
  readonly caseId: number;
  readonly caseNumber: string;
  readonly assessed: string;
  readonly paid: string;
  readonly outstanding: string;
  readonly settled: boolean;
}

/**
 * Reassessment, lineage, payments and closure.
 *
 * Plan reference: V2 sections 14.1 to 14.6.
 *
 * ## The shape of a reassessment is not offered as a choice
 *
 * There is one button. Whether it continues this case or opens a successor is
 * decided by the case's status, because the status is what determines which of
 * the two is legally available. A dropdown here would invite an officer to
 * pick the wrong one.
 *
 * ## Why a payment is recorded from the closure tab
 *
 * Settlement is what makes a served case closable, and the officer chasing
 * closure is the one holding the remittance. The entry still goes to the
 * taxpayer's account for the period rather than to this case, because that is
 * what a payment is against.
 *
 * ## Why the limitation override is a separate, deliberately awkward field
 *
 * Assessing beyond the limitation date is lawful only on narrow grounds such
 * as fraud. It needs a reason and an identified authoriser, and the field is
 * left empty and unmarked so that using it is a conscious act rather than a
 * default that gets filled in out of habit.
 */
@Component({
  selector: 'tas-case-closure',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, RouterLink, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <h2 style="margin-top:0">Reassess</h2>
      <p class="tas-muted">
        A dispute outcome reassesses this case in place. A closed case is succeeded by a new one.
        The status decides which; you do not choose.
      </p>
      <div class="tas-field">
        <label for="re-grounds">Grounds</label>
        <textarea
          id="re-grounds"
          [(ngModel)]="grounds"
          placeholder="What has changed, and on what authority."
        ></textarea>
      </div>
      <div class="tas-field" style="margin-block-start:0.75rem">
        <label for="re-override">Limitation override reason</label>
        <input id="re-override" [(ngModel)]="limitationOverrideReason" />
        <span class="tas-field__hint">
          Only where the reassessment reaches past the limitation date. Lawful on narrow grounds
          such as fraud, and attributed to you.
        </span>
      </div>
      <div class="tas-row" style="margin-block-start:1rem">
        <button
          type="button"
          class="tas-btn tas-btn--primary"
          [disabled]="busy()"
          (click)="reassess()"
        >
          Open reassessment
        </button>
      </div>

      @if (reassessments().length > 0) {
        <h4 style="margin-block-start:1.5rem">Reassessments on this case</h4>
        <table class="tas-table">
          <thead>
            <tr>
              <th>Shape</th>
              <th>Trigger</th>
              <th>Within limitation</th>
              <th>Grounds</th>
            </tr>
          </thead>
          <tbody>
            @for (r of reassessments(); track $index) {
              <tr>
                <td>{{ r['shape'] }}</td>
                <td>{{ r['trigger_source'] }}</td>
                <td>
                  @if (r['within_limitation']) {
                    Yes
                  } @else {
                    <strong style="color:var(--tas-danger)">Overridden</strong>
                  }
                </td>
                <td class="tas-muted">{{ r['grounds'] }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Every assessment of this period</h2>
      <p class="tas-muted">
        Predecessors and successors, however many times the period was assessed.
      </p>
      @if (lineage().length <= 1) {
        <tas-empty>This is the only assessment of the period.</tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Case</th>
              <th>Type</th>
              <th>Status</th>
              <th style="text-align:end">Net payable</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of lineage(); track entry.id) {
              <tr>
                <td>
                  <a [routerLink]="['/cases', entry.id]">{{ entry.case_number }}</a>
                </td>
                <td>{{ entry.assessment_type }}</td>
                <td><tas-status [status]="entry.status_code" /></td>
                <td class="tas-amount">{{ entry.net_payable | tasAmount }}</td>
                <td class="tas-muted">{{ entry.opened_at | date: 'yyyy-MM-dd' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Payments</h2>
      <p class="tas-muted">
        A payment is recorded against the taxpayer's account for this tax type and year, not against
        this case. Whether it settles the case is the platform's conclusion from the figures, not
        anybody's assertion.
      </p>
      <div class="tas-grid">
        <div class="tas-field">
          <label for="pay-type">Payment type</label>
          <select id="pay-type" [(ngModel)]="paymentType">
            <option value="PAYMENT">Payment</option>
            <option value="ADVANCE_PAYMENT">Advance payment</option>
          </select>
        </div>
        <div class="tas-field">
          <label for="pay-amount">Amount</label>
          <input id="pay-amount" [(ngModel)]="amount" />
          <span class="tas-field__hint">The money received, entered as a decimal string.</span>
        </div>
      </div>
      <div class="tas-field" style="margin-block-start:0.75rem">
        <label for="pay-date">Value date</label>
        <input id="pay-date" type="date" [(ngModel)]="valueDate" />
        <span class="tas-field__hint">The date the money was received.</span>
      </div>
      <div class="tas-field" style="margin-block-start:0.75rem">
        <label for="pay-reference">Source reference</label>
        <input id="pay-reference" [(ngModel)]="sourceReference" />
        <span class="tas-field__hint">
          The bank or receipt reference. The same reference cannot be credited twice.
        </span>
      </div>
      <div class="tas-row" style="margin-block-start:1rem">
        <button
          type="button"
          class="tas-btn tas-btn--primary"
          [disabled]="busy()"
          (click)="recordPayment()"
        >
          Record payment
        </button>
      </div>

      @if (settlement(); as s) {
        <dl class="tas-facts" style="margin-block-start:1rem">
          <div>
            <dt>Assessed</dt>
            <dd class="tas-amount">{{ s.assessed | tasAmount }}</dd>
          </div>
          <div>
            <dt>Received since the calculation</dt>
            <dd class="tas-amount">{{ s.paid | tasAmount }}</dd>
          </div>
          <div>
            <dt>Outstanding</dt>
            <dd class="tas-amount">{{ s.outstanding | tasAmount }} {{ currency }}</dd>
          </div>
        </dl>
        <p class="tas-muted">
          @if (s.settled) {
            The case settled on this payment.
          } @else {
            The case did not settle. Either the outstanding figure is still above the tolerance, or
            the case was not awaiting a response.
          }
        </p>
      }
    </div>

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Closure</h2>

      @if (closure(); as c) {
        <div class="tas-alert">
          <strong>Closed {{ c.reason_code }}</strong> on {{ c.closed_at | date: 'yyyy-MM-dd'
          }}{{ c.auto_closed ? ' (automatically)' : '' }}.
          <dl class="tas-facts" style="margin-block-start:0.75rem">
            <div>
              <dt>Assessed</dt>
              <dd class="tas-amount">{{ c.final_assessed_amount | tasAmount }}</dd>
            </div>
            <div>
              <dt>Paid</dt>
              <dd class="tas-amount">{{ c.final_paid_amount | tasAmount }}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd class="tas-amount">{{ c.final_balance | tasAmount }} {{ c.currency_code }}</dd>
            </div>
            <div>
              <dt>Retention</dt>
              <dd>{{ c.retention_class }} until {{ c.retain_until ?? 'indefinitely' }}</dd>
            </div>
          </dl>
          @if (c.narrative) {
            <p class="tas-alert__hint">{{ c.narrative }}</p>
          }
        </div>

        <h4>Legal hold</h4>
        <p class="tas-muted">
          A hold outranks the retention date: a file under litigation survives its own destruction
          schedule. Both placing and lifting one require a reason.
        </p>
        @if (c.legal_hold) {
          <div class="tas-alert tas-alert--danger">
            <strong>On hold.</strong> {{ c.legal_hold_reason }}
          </div>
        }
        <div class="tas-field" style="margin-block-start:0.75rem">
          <label for="hold-reason">Reason</label>
          <input id="hold-reason" [(ngModel)]="holdReason" />
        </div>
        <div class="tas-row" style="margin-block-start:0.75rem">
          <button type="button" class="tas-btn" (click)="setHold(true)">Place hold</button>
          <button type="button" class="tas-btn tas-btn--danger" (click)="setHold(false)">
            Lift hold
          </button>
        </div>
      } @else {
        <p class="tas-muted">
          Closing freezes the final position into the record. The balance is snapshotted rather than
          recomputed later, because the file must say what it said at the time.
        </p>
        <div class="tas-grid">
          <div class="tas-field">
            <label for="close-reason">Reason code</label>
            <input id="close-reason" [(ngModel)]="reasonCode" placeholder="SETTLED_IN_FULL" />
            <span class="tas-field__hint">
              Must be configured for the jurisdiction; the API lists the valid ones if not.
            </span>
          </div>
          <div class="tas-field">
            <label for="close-retention">Retention class</label>
            <select id="close-retention" [(ngModel)]="retentionClass">
              <option value="STATUTORY">Statutory</option>
              <option value="EXTENDED">Extended</option>
              <option value="PERMANENT">Permanent</option>
            </select>
          </div>
        </div>
        <div class="tas-field" style="margin-block-start:0.75rem">
          <label for="close-narrative">Narrative</label>
          <textarea id="close-narrative" [(ngModel)]="narrative"></textarea>
        </div>
        <div class="tas-row" style="margin-block-start:1rem">
          <button
            type="button"
            class="tas-btn tas-btn--primary"
            [disabled]="busy()"
            (click)="close()"
          >
            Close case
          </button>
        </div>
      }
    </div>
  `,
})
export class CaseClosure implements OnInit {
  private readonly assessment = inject(AssessmentService);

  @Input({ required: true }) caseId!: number;
  @Input() status = '';
  @Input({ required: true }) taxpayerId!: number;
  @Input() taxTypeCode = '';
  @Input() assessmentYear = '';
  @Input() currency = '';
  @Output() readonly changed = new EventEmitter<void>();

  readonly closure = signal<ClosureRecord | null>(null);
  readonly lineage = signal<readonly LineageEntry[]>([]);
  readonly reassessments = signal<readonly Record<string, unknown>[]>([]);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly settlement = signal<SettlementPosition | null>(null);

  grounds = '';
  limitationOverrideReason = '';
  reasonCode = '';
  retentionClass = 'STATUTORY';
  narrative = '';
  holdReason = '';
  paymentType = 'PAYMENT';
  amount = '';
  valueDate = '';
  sourceReference = '';

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    try {
      this.lineage.set(await this.assessment.lineage(this.caseId));
      this.reassessments.set(await this.assessment.reassessments(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    }
    try {
      this.closure.set(await this.assessment.closure(this.caseId));
    } catch {
      // Not closed. The absence is the normal state, not a failure.
      this.closure.set(null);
    }
  }

  private async run(work: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
      await this.load();
      this.changed.emit();
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async reassess(): Promise<void> {
    await this.run(async () => {
      await this.assessment.reassess(this.caseId, {
        grounds: this.grounds,
        limitationOverrideReason:
          this.limitationOverrideReason === '' ? undefined : this.limitationOverrideReason,
      });
      this.grounds = '';
      this.limitationOverrideReason = '';
    });
  }

  async close(): Promise<void> {
    await this.run(() =>
      this.assessment.close(this.caseId, {
        reasonCode: this.reasonCode,
        narrative: this.narrative === '' ? undefined : this.narrative,
        retentionClass: this.retentionClass,
      }),
    );
  }

  async setHold(hold: boolean): Promise<void> {
    await this.run(() => this.assessment.setLegalHold(this.caseId, hold, this.holdReason));
  }

  async recordPayment(): Promise<void> {
    await this.run(async () => {
      this.settlement.set(null);
      const response = await this.assessment.recordAccountEntry(this.taxpayerId, {
        entryType: this.paymentType,
        taxTypeCode: this.taxTypeCode,
        assessmentYear: this.assessmentYear,
        amount: this.amount.trim(),
        currencyCode: this.currency,
        valueDate: this.valueDate,
        sourceReference:
          this.sourceReference.trim() === '' ? undefined : this.sourceReference.trim(),
      });
      const settlements = (response['settlements'] ?? []) as readonly SettlementPosition[];
      this.settlement.set(settlements.find((entry) => entry.caseId === this.caseId) ?? null);
      this.amount = '';
      this.valueDate = '';
      this.sourceReference = '';
    });
  }
}
