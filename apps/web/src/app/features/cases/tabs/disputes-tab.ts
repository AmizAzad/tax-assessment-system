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
import { FormsModule } from '@angular/forms';
import { AssessmentService } from '../../../core/assessment.service';
import type {
  AppealSummary,
  DepositPosition,
  ObjectionDetail,
  ObjectionSummary,
} from '../../../core/domain';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../../shared/ui';

/**
 * Objections and appeals on a case.
 *
 * Plan reference: V2 sections 13.1 to 13.7.
 *
 * ## Lateness is shown, admissibility is asked for
 *
 * An objection filed out of time is displayed with the number of days, and the
 * admissibility panel is offered anyway. The platform computes whether it was
 * late; whether a late objection is heard is a discretion the law gives to a
 * person, and this screen is where that person exercises it. A form that
 * refused to accept a late objection would remove the discretion.
 *
 * ## Appeals have no approve button
 *
 * An appeal is decided by a forum outside the authority. The officer using
 * this screen is transcribing a judgment, which is why the control is
 * "Record outcome" and why implementation is a separate act afterwards.
 */
@Component({
  selector: 'tas-case-disputes',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <h2 style="margin-top:0">File an objection</h2>
      <p class="tas-muted">
        Accepted even out of time. Objections arrive by post as often as through a portal, so an
        officer may record one on the taxpayer's behalf.
      </p>
      <div class="tas-field">
        <label for="obj-summary">Grounds</label>
        <textarea
          id="obj-summary"
          [(ngModel)]="groundsSummary"
          placeholder="What is disputed, and why."
        ></textarea>
      </div>
      <div class="tas-grid" style="margin-block-start:0.75rem">
        <div class="tas-field">
          <label for="obj-ground">Ground code</label>
          <input id="obj-ground" [(ngModel)]="groundCode" placeholder="FACTUAL_ERROR" />
        </div>
        <div class="tas-field">
          <label for="obj-disputed">Disputed amount</label>
          <input id="obj-disputed" type="text" inputmode="decimal" [(ngModel)]="disputedAmount" />
        </div>
        <div class="tas-field">
          <label for="obj-channel">Arrived by</label>
          <select id="obj-channel" [(ngModel)]="filedChannel">
            <option value="PORTAL">Portal</option>
            <option value="POST">Post</option>
            <option value="EMAIL">Email</option>
            <option value="IN_PERSON">In person</option>
          </select>
        </div>
      </div>
      <div class="tas-row" style="margin-block-start:1rem">
        <button
          type="button"
          class="tas-btn tas-btn--primary"
          [disabled]="busy()"
          (click)="fileObjection()"
        >
          File objection
        </button>
      </div>
    </div>

    @if (objections().length === 0) {
      <div class="tas-card" style="margin-block-start:1rem">
        <tas-empty>No objections. The assessment stands as issued.</tas-empty>
      </div>
    }

    @for (summary of objections(); track summary.uuid) {
      <div class="tas-card" style="margin-block-start:1rem">
        <div class="tas-page-head" style="margin-block-end:0.5rem">
          <div>
            <h3 style="margin:0; display:flex; gap:0.75rem; align-items:center">
              {{ summary.objection_number }}
              <tas-status [status]="summary.status" />
            </h3>
            <p class="tas-muted" style="margin:0.25rem 0 0">
              Filed {{ summary.filed_on }} ·
              @if (summary.was_in_time) {
                in time
              } @else {
                <strong>{{ summary.days_late }} day(s) out of time</strong>
              }
              · admissibility {{ summary.admissibility }}
            </p>
          </div>
          <button type="button" class="tas-btn" (click)="openObjection(summary.uuid)">
            {{ detail()?.uuid === summary.uuid ? 'Hide' : 'Work it' }}
          </button>
        </div>

        @if (detail(); as d) {
          @if (d.uuid === summary.uuid) {
            <p>{{ d.grounds_summary }}</p>

            @if (d.grounds.length > 0) {
              <table class="tas-table">
                <thead>
                  <tr>
                    <th>Ground</th>
                    <th>Detail</th>
                    <th style="text-align:end">Disputed</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  @for (ground of d.grounds; track ground.id) {
                    <tr>
                      <td>
                        <code>{{ ground.ground_code }}</code>
                      </td>
                      <td class="tas-muted">{{ ground.detail ?? '—' }}</td>
                      <td class="tas-amount">{{ ground.disputed_amount | tasAmount }}</td>
                      <td>{{ ground.outcome ?? '—' }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            }

            @if (deposit(); as dep) {
              <div class="tas-alert" style="margin-block-start:1rem">
                <strong>Deposit</strong> —
                @if (dep.required) {
                  {{ dep.amount | tasAmount }} {{ dep.currencyCode }} required,
                  {{ dep.paid | tasAmount }} paid, {{ dep.outstanding | tasAmount }} outstanding.
                  <p class="tas-alert__hint">{{ dep.derivation }}</p>
                  <div class="tas-row" style="margin-block-start:0.5rem">
                    <input type="text" inputmode="decimal" [(ngModel)]="depositAmount" />
                    <button type="button" class="tas-btn" (click)="payDeposit(d.uuid)">
                      Record deposit
                    </button>
                  </div>
                } @else {
                  none required in this jurisdiction.
                }
              </div>
            }

            @if (d.opinions.length > 0) {
              <h4>Panel opinions</h4>
              <ul>
                @for (opinion of d.opinions; track opinion.member_user_id) {
                  <li>
                    <strong>{{ opinion.username ?? opinion.member_user_id }}</strong
                    >:
                    {{ opinion.opinion }}
                    @if (opinion.reasoning) {
                      — <span class="tas-muted">{{ opinion.reasoning }}</span>
                    }
                  </li>
                }
              </ul>
            }

            @if (d.admissibility === 'PENDING') {
              <h4>Admissibility</h4>
              <p class="tas-muted">
                Refusing to hear someone must give a reason they can challenge. A late objection may
                still be admitted for good cause.
              </p>
              <div class="tas-field">
                <label for="adm-reason">Reason</label>
                <textarea id="adm-reason" [(ngModel)]="admissibilityReason"></textarea>
              </div>
              <div class="tas-row" style="margin-block-start:0.75rem">
                <button
                  type="button"
                  class="tas-btn tas-btn--primary"
                  (click)="rule(d.uuid, 'ADMITTED')"
                >
                  Admit
                </button>
                <button
                  type="button"
                  class="tas-btn tas-btn--danger"
                  (click)="rule(d.uuid, 'INADMISSIBLE')"
                >
                  Refuse to hear
                </button>
              </div>
            } @else if (d.status !== 'DECIDED') {
              <h4>Opinion and decision</h4>
              <div class="tas-row">
                <select [(ngModel)]="opinion" class="tas-btn">
                  <option value="ALLOW">Allow</option>
                  <option value="PARTLY_ALLOW">Partly allow</option>
                  <option value="REJECT">Reject</option>
                  <option value="ABSTAIN">Abstain</option>
                </select>
                <button type="button" class="tas-btn" (click)="giveOpinion(d.uuid)">
                  Record my opinion
                </button>
              </div>
              <div class="tas-field" style="margin-block-start:0.75rem">
                <label for="dec-reason">Decision reasons</label>
                <textarea id="dec-reason" [(ngModel)]="decisionReason"></textarea>
                <span class="tas-field__hint">
                  A decision without reasons cannot be appealed against intelligibly.
                </span>
              </div>
              <div class="tas-row" style="margin-block-start:0.75rem">
                <select [(ngModel)]="decision" class="tas-btn">
                  <option value="ALLOWED">Allowed</option>
                  <option value="PARTLY_ALLOWED">Partly allowed</option>
                  <option value="REJECTED">Rejected</option>
                </select>
                <button type="button" class="tas-btn tas-btn--primary" (click)="decide(d.uuid)">
                  Decide
                </button>
              </div>
            } @else {
              <div class="tas-alert">
                <strong>Decided {{ d.decision }}</strong> on {{ d.decided_on }}.
                <p class="tas-alert__hint">{{ d.decision_reason }}</p>
              </div>
            }
          }
        }
      </div>
    }

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Appeals</h2>
      <p class="tas-muted">
        Decided by a forum outside the authority. This screen records what was held; it does not
        decide anything.
      </p>

      @if (appeals().length === 0) {
        <tas-empty>No appeals.</tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Appeal</th>
              <th>Forum</th>
              <th>Filed</th>
              <th>Status</th>
              <th>Outcome</th>
              <th>Implemented</th>
            </tr>
          </thead>
          <tbody>
            @for (appeal of appeals(); track appeal.uuid) {
              <tr>
                <td>{{ appeal.appeal_number }}</td>
                <td>
                  {{ appeal.forum_code }}
                  @if (appeal.external_reference) {
                    <div class="tas-muted" style="font-size:0.8rem">
                      {{ appeal.external_reference }}
                    </div>
                  }
                </td>
                <td>{{ appeal.filed_on }}</td>
                <td><tas-status [status]="appeal.status" /></td>
                <td>{{ appeal.outcome ?? '—' }}</td>
                <td>
                  @if (appeal.implemented_at) {
                    Yes
                  } @else if (appeal.outcome) {
                    <button type="button" class="tas-btn" (click)="implement(appeal.uuid)">
                      Implement
                    </button>
                  } @else {
                    —
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }

      <h4>File an appeal</h4>
      <div class="tas-grid">
        <div class="tas-field">
          <label for="app-forum">Forum</label>
          <input id="app-forum" [(ngModel)]="forumCode" placeholder="FIRST_TIER_TRIBUNAL" />
          <span class="tas-field__hint">
            Must be a forum the jurisdiction recognises; the API lists them if not.
          </span>
        </div>
        <div class="tas-field">
          <label for="app-ref">Forum reference</label>
          <input id="app-ref" [(ngModel)]="externalReference" />
        </div>
      </div>
      <div class="tas-field" style="margin-block-start:0.75rem">
        <label for="app-grounds">Grounds</label>
        <textarea id="app-grounds" [(ngModel)]="appealGrounds"></textarea>
      </div>
      <div class="tas-row" style="margin-block-start:0.75rem">
        <button
          type="button"
          class="tas-btn tas-btn--primary"
          [disabled]="busy()"
          (click)="fileAppeal()"
        >
          File appeal
        </button>
      </div>

      <h4 style="margin-block-start:1.5rem">Record what the forum held</h4>
      <div class="tas-row">
        <select [(ngModel)]="appealOutcome" class="tas-btn">
          <option value="UPHELD">Upheld (assessment stands)</option>
          <option value="VARIED">Varied</option>
          <option value="SET_ASIDE">Set aside</option>
          <option value="REMANDED">Remanded</option>
        </select>
        <input [(ngModel)]="outcomeAppealUuid" placeholder="Appeal uuid" style="min-width:20rem" />
      </div>
      <div class="tas-field" style="margin-block-start:0.75rem">
        <label for="app-outcome-reason">The forum's reasons</label>
        <textarea id="app-outcome-reason" [(ngModel)]="appealReason"></textarea>
      </div>
      <div class="tas-row" style="margin-block-start:0.75rem">
        <button type="button" class="tas-btn tas-btn--primary" (click)="recordOutcome()">
          Record outcome
        </button>
      </div>
    </div>
  `,
})
export class CaseDisputes implements OnInit {
  private readonly assessment = inject(AssessmentService);

  @Input({ required: true }) caseId!: number;
  @Input() status = '';
  @Output() readonly changed = new EventEmitter<void>();

  readonly objections = signal<readonly ObjectionSummary[]>([]);
  readonly appeals = signal<readonly AppealSummary[]>([]);
  readonly detail = signal<ObjectionDetail | null>(null);
  readonly deposit = signal<DepositPosition | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  groundsSummary = '';
  groundCode = 'FACTUAL_ERROR';
  disputedAmount = '';
  filedChannel = 'PORTAL';

  admissibilityReason = '';
  opinion = 'PARTLY_ALLOW';
  decision = 'REJECTED';
  decisionReason = '';
  depositAmount = '';

  forumCode = '';
  externalReference = '';
  appealGrounds = '';
  appealOutcome = 'VARIED';
  appealReason = '';
  outcomeAppealUuid = '';

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    try {
      this.objections.set(await this.assessment.objections(this.caseId));
      this.appeals.set(await this.assessment.appeals(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  async openObjection(uuid: string): Promise<void> {
    if (this.detail()?.uuid === uuid) {
      this.detail.set(null);
      return;
    }
    this.error.set(null);
    try {
      this.detail.set(await this.assessment.objection(uuid));
      this.deposit.set(await this.assessment.depositPosition(uuid));
    } catch (error) {
      this.error.set(describeError(error));
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

  async fileObjection(): Promise<void> {
    await this.run(async () => {
      await this.assessment.fileObjection(this.caseId, {
        groundsSummary: this.groundsSummary,
        grounds: [
          {
            groundCode: this.groundCode,
            disputedAmount: this.disputedAmount === '' ? undefined : this.disputedAmount,
          },
        ],
        filedChannel: this.filedChannel,
      });
      this.groundsSummary = '';
      this.disputedAmount = '';
    });
  }

  async rule(uuid: string, admissibility: string): Promise<void> {
    await this.run(async () => {
      await this.assessment.decideAdmissibility(uuid, {
        admissibility,
        reason: this.admissibilityReason,
      });
      this.admissibilityReason = '';
      this.detail.set(await this.assessment.objection(uuid));
    });
  }

  async giveOpinion(uuid: string): Promise<void> {
    await this.run(async () => {
      await this.assessment.recordOpinion(uuid, { opinion: this.opinion });
      this.detail.set(await this.assessment.objection(uuid));
    });
  }

  async decide(uuid: string): Promise<void> {
    await this.run(async () => {
      await this.assessment.decideObjection(uuid, {
        decision: this.decision,
        reason: this.decisionReason,
      });
      this.decisionReason = '';
      this.detail.set(await this.assessment.objection(uuid));
    });
  }

  async payDeposit(uuid: string): Promise<void> {
    await this.run(async () => {
      this.deposit.set(await this.assessment.recordDeposit(uuid, this.depositAmount));
      this.depositAmount = '';
    });
  }

  async fileAppeal(): Promise<void> {
    await this.run(async () => {
      await this.assessment.fileAppeal(this.caseId, {
        forumCode: this.forumCode,
        groundsSummary: this.appealGrounds,
        externalReference: this.externalReference === '' ? undefined : this.externalReference,
      });
      this.appealGrounds = '';
    });
  }

  async recordOutcome(): Promise<void> {
    await this.run(() =>
      this.assessment.recordAppealOutcome(this.outcomeAppealUuid, {
        outcome: this.appealOutcome,
        reason: this.appealReason,
      }),
    );
  }

  async implement(uuid: string): Promise<void> {
    await this.run(() =>
      this.assessment.implementAppeal(uuid, 'Given effect from the case workbench.'),
    );
  }
}
