import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AssessmentService } from '../../../core/assessment.service';
import { AuthService } from '../../../core/auth.service';
import type { ClosureRecord, LineageEntry, MasterItem } from '../../../core/domain';
import { humanise } from '../../../core/domain';
import { I18nService } from '../../../core/i18n.service';
import {
  AmountPipe,
  EmptyState,
  ErrorAlert,
  HumanisePipe,
  StatusBadge,
  describeError,
} from '../../../shared/ui';
import { canCloseFrom, canReassessFrom, isNotFound, mayHaveClosure } from './case-rules';

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
  imports: [
    FormsModule,
    DatePipe,
    RouterLink,
    AmountPipe,
    HumanisePipe,
    StatusBadge,
    EmptyState,
    ErrorAlert,
  ],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <h2 style="margin-top:0">Reassess</h2>
      <p class="tas-muted">
        A dispute outcome reassesses this case in place. A closed case is succeeded by a new one.
        The status decides which; you do not choose.
      </p>
      @if (holds('POST', '/api/v1/cases/:id/reassess') && canReassessFrom(status)) {
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
      } @else if (holds('POST', '/api/v1/cases/:id/reassess')) {
        <p class="tas-muted" style="margin:0">
          Not from {{ status | tasHumanise }}. A reassessment follows an objection or appeal that
          went the taxpayer's way, or a case that has been closed, settled or written off.
        </p>
      }

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
              <th class="tas-amount">Net payable</th>
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

    @if (holds('POST', '/api/v1/taxpayers/:taxpayerId/account')) {
      <div class="tas-card" style="margin-block-start:1rem">
        <h2 style="margin-top:0">Payments</h2>
        <p class="tas-muted">
          A payment is recorded against the taxpayer's account for this tax type and year, not
          against this case. Whether it settles the case is the platform's conclusion from the
          figures, not anybody's assertion.
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
              The case did not settle. Either the outstanding figure is still above the tolerance,
              or the case was not awaiting a response.
            }
          </p>
        }
      </div>
    }

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Closure</h2>

      @if (closure(); as c) {
        <div class="tas-alert">
          <strong>Closed: {{ c.reason_code | tasHumanise }}</strong> on
          {{ c.closed_at | date: 'yyyy-MM-dd' }}{{ c.auto_closed ? ' (automatically)' : '' }}.
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
              <dd>
                {{ c.retention_class | tasHumanise }} until {{ c.retain_until ?? 'indefinitely' }}
              </dd>
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
        @if (holds('POST', '/api/v1/cases/:id/legal-hold')) {
          <div class="tas-field" style="margin-block-start:0.75rem">
            <label for="hold-reason">Reason</label>
            <input id="hold-reason" [(ngModel)]="holdReason" />
          </div>
          <div class="tas-row" style="margin-block-start:0.75rem">
            @if (c.legal_hold) {
              <button type="button" class="tas-btn tas-btn--danger" (click)="setHold(false)">
                Lift hold
              </button>
            } @else {
              <button type="button" class="tas-btn" (click)="setHold(true)">Place hold</button>
            }
          </div>
        }
      } @else if (status === 'CLOSED') {
        <p class="tas-muted" style="margin:0">
          Closed without a closure record, so there is no frozen final position to show. A case
          closes this way when its response window lapses with nobody acting on it.
        </p>
      } @else if (!holds('POST', '/api/v1/cases/:id/close')) {
        <p class="tas-muted" style="margin:0">Not closed.</p>
      } @else if (!canCloseFrom(status)) {
        <p class="tas-muted" style="margin:0">
          Not from {{ status | tasHumanise }}. A case is closed once it has settled, once a rejected
          objection is not taken further, or once an appeal sets the assessment aside.
        </p>
      } @else {
        <p class="tas-muted">
          Closing freezes the final position into the record. The balance is snapshotted rather than
          recomputed later, because the file must say what it said at the time.
        </p>
        <div class="tas-grid">
          <div class="tas-field">
            <label for="close-reason">Reason</label>
            <select id="close-reason" [(ngModel)]="reasonCode">
              @for (item of reasons(); track item.itemCode) {
                <option [value]="item.itemCode">{{ label(item) }}</option>
              }
            </select>
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
            [disabled]="busy() || reasonCode === ''"
            (click)="close()"
          >
            Close case
          </button>
        </div>
      }
    </div>
  `,
})
export class CaseClosure implements OnInit, OnChanges {
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(I18nService);

  @Input({ required: true }) caseId!: number;
  @Input() status = '';
  @Input({ required: true }) taxpayerId!: number;
  @Input() taxTypeCode = '';
  @Input() assessmentYear = '';
  @Input() currency = '';
  /** The case's own jurisdiction, whose closure reasons the server accepts. */
  @Input() jurisdiction = '';
  @Output() readonly changed = new EventEmitter<void>();

  readonly canReassessFrom = canReassessFrom;
  readonly canCloseFrom = canCloseFrom;
  readonly reasons = signal<readonly MasterItem[]>([]);

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
    await Promise.all([this.load(), this.loadReasons()]);
  }

  /**
   * Closing is followed by the page re-reading the case, so the status this
   * tab holds turns CLOSED after its own reload has already run. Re-reading
   * on the change is what makes the record appear rather than the
   * "closed without a record" note.
   */
  async ngOnChanges(changes: SimpleChanges): Promise<void> {
    const status = changes['status'];
    if (status !== undefined && !status.firstChange) {
      await this.load();
    }
  }

  async load(): Promise<void> {
    try {
      this.lineage.set(await this.assessment.lineage(this.caseId));
      this.reassessments.set(await this.assessment.reassessments(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    }
    // Asked only where a record can exist; everywhere else the answer is
    // known, and asking logged a 404 on every visit to this tab.
    if (!mayHaveClosure(this.status)) {
      this.closure.set(null);
      return;
    }
    try {
      this.closure.set((await this.assessment.closure(this.caseId)) ?? null);
    } catch (error) {
      this.closure.set(null);
      if (!isNotFound(error)) {
        this.error.set(describeError(error));
      }
    }
  }

  /**
   * The closure reasons this jurisdiction configures.
   *
   * Fetched only for someone who can close, because nobody else is shown the
   * form. The server refuses a reason the jurisdiction does not list, so a
   * free-text box only taught officers the valid codes by refusal.
   */
  private async loadReasons(): Promise<void> {
    if (!this.holds('POST', '/api/v1/cases/:id/close')) return;
    try {
      const group = await this.assessment.masterCodes('CLOSURE_REASON', this.jurisdiction);
      this.reasons.set(group.items);
      this.reasonCode = group.items[0]?.itemCode ?? '';
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  holds(method: string, path: string): boolean {
    return this.auth.canInvoke(method, path);
  }

  /**
   * A configured code by its translated name.
   *
   * Falling back to the humanised code rather than the key: most catalogues
   * ship without English text, and "Factual error" is what the officer
   * would have typed where `ta.master.objectionGround.factualError` is not.
   */
  label(item: MasterItem): string {
    return this.i18n.t(item.displayKey, humanise(item.itemCode));
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
