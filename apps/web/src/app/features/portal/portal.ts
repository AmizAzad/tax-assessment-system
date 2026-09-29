import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe, LowerCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { APP_CONFIG } from '../../core/config';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../shared/ui';

interface PortalIdentity {
  readonly taxpayerId: number;
  readonly tin: string;
  readonly name: string;
  readonly relationship: string;
  readonly jurisdictionCode: string;
}

/**
 * The taxpayer's own view.
 *
 * Plan reference: V2 sections 15.1 to 15.4.
 *
 * ## Written for somebody who is not a tax officer
 *
 * The officer screens use the system's vocabulary because officers work in it
 * all day. This one does not. A taxpayer reading it has received a demand and
 * wants to know three things: how much, by when, and what they can do about
 * it. So the figures come first, the objection route is stated plainly, and
 * the status codes are explained rather than displayed.
 *
 * ## What it deliberately cannot show
 *
 * There is no calculation trace, no adjustment list, no evidence panel. Those
 * are the officer's working papers. What a taxpayer is entitled to is the
 * notice served on them and the figures it states, and the API will not return
 * more than that however this screen asks.
 */
@Component({
  selector: 'tas-portal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, LowerCasePipe, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    @if (identity(); as me) {
      <div class="tas-page-head">
        <div>
          <h1>Your tax affairs</h1>
          <p class="tas-muted">
            {{ me.name }} · {{ me.tin }}
            @if (me.relationship !== 'OWNER') {
              · you are acting as {{ me.relationship | lowercase }}
            }
          </p>
        </div>
      </div>

      <nav class="tas-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="active() === 'assessments'"
          (click)="select('assessments')"
        >
          Assessments
        </button>
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="active() === 'account'"
          (click)="select('account')"
        >
          Payments and credits
        </button>
      </nav>

      @if (active() === 'assessments') {
        @if (cases().length === 0) {
          <tas-empty>
            You have no assessments. Nothing is outstanding, and there is nothing to respond to.
          </tas-empty>
        }

        @for (row of cases(); track row['id']) {
          <div class="tas-card" style="margin-block-end:1rem">
            <div class="tas-page-head" style="margin-block-end:0.5rem">
              <div>
                <h2 style="margin:0">
                  {{ row['tax_type_code'] }} for {{ row['assessment_year'] }}
                </h2>
                <p class="tas-muted" style="margin:0.25rem 0 0">
                  Reference {{ row['case_number'] }}
                </p>
              </div>
              <div style="text-align:end">
                <div class="tas-amount" style="font-size:1.4rem; font-weight:600">
                  {{ text(row['net_payable']) | tasAmount }} {{ row['currency_code'] }}
                </div>
                <div class="tas-muted" style="font-size:0.8rem">
                  {{ explain(row['status_code']) }}
                </div>
              </div>
            </div>

            <div class="tas-row">
              <button type="button" class="tas-btn" (click)="openCase(num(row['id']))">
                {{ openCaseId() === num(row['id']) ? 'Hide detail' : 'See the detail' }}
              </button>
            </div>

            @if (openCaseId() === num(row['id'])) {
              @if (detail(); as d) {
                <table class="tas-table" style="max-width:30rem; margin-block-start:1rem">
                  <tbody>
                    <tr>
                      <td>Amount charged to tax</td>
                      <td class="tas-amount">{{ text(d['taxable_base']) | tasAmount }}</td>
                    </tr>
                    <tr>
                      <td>Tax</td>
                      <td class="tas-amount">{{ text(d['tax_before_credits']) | tasAmount }}</td>
                    </tr>
                    <tr>
                      <td>Less credits</td>
                      <td class="tas-amount">{{ text(d['total_credits']) | tasAmount }}</td>
                    </tr>
                    <tr>
                      <td>Penalty</td>
                      <td class="tas-amount">{{ text(d['penalty_amount']) | tasAmount }}</td>
                    </tr>
                    <tr>
                      <td>Interest</td>
                      <td class="tas-amount">{{ text(d['interest_amount']) | tasAmount }}</td>
                    </tr>
                    <tr>
                      <td><strong>Amount payable</strong></td>
                      <td class="tas-amount">
                        <strong>{{ text(d['net_payable_or_refundable']) | tasAmount }}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              }

              <h3>Notices sent to you</h3>
              @if (notices().length === 0) {
                <p class="tas-muted">Nothing has been served on you for this assessment yet.</p>
              } @else {
                <table class="tas-table">
                  <thead>
                    <tr>
                      <th>Notice</th>
                      <th>Sent</th>
                      <th>Treated as received</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (notice of notices(); track notice['uuid']) {
                      <tr>
                        <td>{{ notice['rendered_title'] }}</td>
                        <td>{{ asDate(notice['issued_at']) | date: 'd MMMM yyyy' }}</td>
                        <td>{{ notice['deemed_served_on'] }}</td>
                        <td>
                          @if (notice['document_uuid']) {
                            <a
                              class="tas-btn"
                              [href]="noticeUrl(text(notice['uuid']))"
                              target="_blank"
                              rel="noopener"
                              >Download</a
                            >
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
                <p class="tas-muted" style="font-size:0.85rem">
                  The date a notice is treated as received is what your time to object runs from. It
                  is not always the date it was sent.
                </p>
              }

              <h3>Disagreeing with this assessment</h3>
              @if (objections().length > 0) {
                <table class="tas-table">
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Filed</th>
                      <th>Progress</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (objection of objections(); track objection['uuid']) {
                      <tr>
                        <td>{{ objection['objection_number'] }}</td>
                        <td>{{ objection['filed_on'] }}</td>
                        <td><tas-status [status]="text(objection['status'])" /></td>
                        <td>
                          {{ objection['decision'] ?? 'Not yet decided' }}
                          @if (objection['decision_reason']) {
                            <div class="tas-muted" style="font-size:0.8rem">
                              {{ objection['decision_reason'] }}
                            </div>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="tas-muted">
                  If you think this assessment is wrong you may object. Say what is wrong and why;
                  an officer who had no part in making the assessment will decide.
                </p>
                <div class="tas-field">
                  <label [attr.for]="'obj-' + row['id']">What is wrong with it</label>
                  <textarea
                    [attr.id]="'obj-' + row['id']"
                    [(ngModel)]="grounds"
                    placeholder="Explain what you disagree with, and what you say the correct position is."
                  ></textarea>
                </div>
                <div class="tas-grid" style="margin-block-start:0.75rem">
                  <div class="tas-field">
                    <label [attr.for]="'gc-' + row['id']">The kind of problem</label>
                    <select [attr.id]="'gc-' + row['id']" [(ngModel)]="groundCode">
                      <option value="FACTUAL_ERROR">A figure or fact is wrong</option>
                      <option value="NEW_EVIDENCE">I have evidence not considered</option>
                      <option value="LEGAL_INTERPRETATION">The law has been applied wrongly</option>
                      <option value="PROCEDURAL_IRREGULARITY">The process was not followed</option>
                    </select>
                  </div>
                  <div class="tas-field">
                    <label [attr.for]="'da-' + row['id']">Amount in dispute (optional)</label>
                    <input
                      [attr.id]="'da-' + row['id']"
                      type="text"
                      inputmode="decimal"
                      [(ngModel)]="disputedAmount"
                    />
                  </div>
                </div>
                <div class="tas-row" style="margin-block-start:1rem">
                  <button
                    type="button"
                    class="tas-btn tas-btn--primary"
                    [disabled]="busy()"
                    (click)="objectTo(num(row['id']))"
                  >
                    Send my objection
                  </button>
                </div>
              }
            }
          </div>
        }
      } @else {
        <div class="tas-card">
          <h2 style="margin-top:0">What we have received from you</h2>
          @if (entries().length === 0) {
            <tas-empty>No payments or credits are recorded.</tas-empty>
          } @else {
            <table class="tas-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th>Period</th>
                  <th class="tas-amount">Amount</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of entries(); track $index) {
                  <tr>
                    <td>{{ entry['value_date'] }}</td>
                    <td>{{ friendlyEntry(text(entry['entry_type'])) }}</td>
                    <td>{{ entry['tax_type_code'] }} {{ entry['assessment_year'] }}</td>
                    <td class="tas-amount">
                      {{ text(entry['amount']) | tasAmount }} {{ entry['currency_code'] }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          }

          @if (losses().length > 0) {
            <h3>Losses carried forward</h3>
            <table class="tas-table">
              <thead>
                <tr>
                  <th>From</th>
                  <th class="tas-amount">Arose</th>
                  <th class="tas-amount">Used</th>
                  <th class="tas-amount">Left</th>
                </tr>
              </thead>
              <tbody>
                @for (loss of losses(); track $index) {
                  <tr>
                    <td>{{ loss['origin_year'] }}</td>
                    <td class="tas-amount">{{ text(loss['original_amount']) | tasAmount }}</td>
                    <td class="tas-amount">{{ text(loss['consumed_amount']) | tasAmount }}</td>
                    <td class="tas-amount">{{ text(loss['remaining_amount']) | tasAmount }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      }
    } @else if (!error()) {
      <p class="tas-muted">Loading…</p>
    }
  `,
})
export class Portal implements OnInit {
  private readonly api = inject(ApiService);

  readonly identity = signal<PortalIdentity | null>(null);
  readonly cases = signal<readonly Record<string, unknown>[]>([]);
  readonly detail = signal<Record<string, unknown> | null>(null);
  readonly notices = signal<readonly Record<string, unknown>[]>([]);
  readonly objections = signal<readonly Record<string, unknown>[]>([]);
  readonly entries = signal<readonly Record<string, unknown>[]>([]);
  readonly losses = signal<readonly Record<string, unknown>[]>([]);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly active = signal('assessments');
  readonly openCaseId = signal<number | null>(null);

  grounds = '';
  groundCode = 'FACTUAL_ERROR';
  disputedAmount = '';

  async ngOnInit(): Promise<void> {
    try {
      this.identity.set(await this.api.get<PortalIdentity>('/portal/me'));
      this.cases.set(await this.api.get('/portal/cases'));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  async select(tab: string): Promise<void> {
    this.active.set(tab);
    if (tab === 'account' && this.entries().length === 0) {
      try {
        const account = await this.api.get<{
          entries: readonly Record<string, unknown>[];
          losses: readonly Record<string, unknown>[];
        }>('/portal/account');
        this.entries.set(account.entries);
        this.losses.set(account.losses);
      } catch (error) {
        this.error.set(describeError(error));
      }
    }
  }

  async openCase(caseId: number): Promise<void> {
    if (this.openCaseId() === caseId) {
      this.openCaseId.set(null);
      return;
    }
    this.error.set(null);
    try {
      this.detail.set(await this.api.get(`/portal/cases/${caseId}`));
      this.notices.set(await this.api.get(`/portal/cases/${caseId}/notices`));
      this.objections.set(await this.api.get(`/portal/cases/${caseId}/objections`));
      this.openCaseId.set(caseId);
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  async objectTo(caseId: number): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.post(`/portal/cases/${caseId}/objections`, {
        groundsSummary: this.grounds,
        grounds: [
          {
            groundCode: this.groundCode,
            disputedAmount: this.disputedAmount === '' ? undefined : this.disputedAmount,
          },
        ],
      });
      this.grounds = '';
      this.disputedAmount = '';
      this.objections.set(await this.api.get(`/portal/cases/${caseId}/objections`));
      this.cases.set(await this.api.get('/portal/cases'));
    } catch (error) {
      // The API's messages are written for the reader, including the one that
      // says an objection needs grounds. Showing them verbatim is more use to
      // a taxpayer than anything this screen could invent.
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  noticeUrl(uuid: string): string {
    return `${APP_CONFIG.apiBaseUrl}/api/v1/portal/notices/${uuid}/document`;
  }

  /**
   * A status code, in words.
   *
   * A taxpayer should not have to learn `AWAITING_TAXPAYER_RESPONSE` to find
   * out that the ball is in their court.
   */
  explain(status: unknown): string {
    const code = typeof status === 'string' ? status : '';
    const wording: Record<string, string> = {
      NOTICE_SERVED: 'Assessed. You may object if you disagree.',
      AWAITING_TAXPAYER_RESPONSE: 'Assessed. You may object if you disagree.',
      UNDER_OBJECTION: 'Your objection is being considered.',
      OBJECTION_ALLOWED: 'Your objection succeeded.',
      OBJECTION_PARTLY_ALLOWED: 'Your objection partly succeeded.',
      OBJECTION_REJECTED: 'Your objection was not accepted. You may be able to appeal.',
      UNDER_APPEAL: 'Your appeal is with the tribunal.',
      APPEAL_UPHELD: 'The tribunal upheld the assessment.',
      APPEAL_VARIED: 'The tribunal changed the assessment.',
      APPEAL_SET_ASIDE: 'The tribunal set the assessment aside.',
      SETTLED: 'Paid in full. Nothing further is due.',
      CLOSED: 'Closed. Nothing further is due.',
    };
    return wording[code] ?? 'In progress.';
  }

  friendlyEntry(type: string): string {
    const wording: Record<string, string> = {
      PAYMENT: 'Payment',
      ADVANCE_PAYMENT: 'Payment on account',
      WITHHOLDING_CREDIT: 'Tax withheld at source',
      FOREIGN_TAX_CREDIT: 'Foreign tax credit',
    };
    return wording[type] ?? type;
  }

  text(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  num(value: unknown): number {
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  asDate(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }
}
