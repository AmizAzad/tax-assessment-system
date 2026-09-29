import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  computed,
  Input,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { LowerCasePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AssessmentService } from '../../../core/assessment.service';
import { AuthService } from '../../../core/auth.service';
import type {
  AppealSummary,
  DepositPosition,
  MasterItem,
  ObjectionDetail,
  ObjectionSummary,
} from '../../../core/domain';
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
import { canAppealFrom, canObjectFrom } from './case-rules';

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
  imports: [
    FormsModule,
    LowerCasePipe,
    AmountPipe,
    HumanisePipe,
    StatusBadge,
    EmptyState,
    ErrorAlert,
  ],
  template: `
    <tas-error [message]="error()" />

    @if (showFiling()) {
      <div class="tas-card">
        <h2 style="margin-top:0">File an objection</h2>
        @if (canObjectFrom(status)) {
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
              <label for="obj-ground">Ground</label>
              <select id="obj-ground" [(ngModel)]="groundCode">
                @for (item of grounds(); track item.itemCode) {
                  <option [value]="item.itemCode">{{ label(item) }}</option>
                }
              </select>
            </div>
            <div class="tas-field">
              <label for="obj-disputed">Disputed amount</label>
              <input
                id="obj-disputed"
                type="text"
                inputmode="decimal"
                [(ngModel)]="disputedAmount"
              />
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
              [disabled]="busy() || groundCode === ''"
              (click)="fileObjection()"
            >
              File objection
            </button>
          </div>
        } @else {
          <p class="tas-muted" style="margin:0">
            An objection lies against a served assessment. This one is
            {{ status | tasHumanise }}, so there is nothing to object to yet.
          </p>
        }
      </div>
    }

    @if (objections().length === 0) {
      <div class="tas-card" [style.margin-block-start]="firstCardGap()">
        <tas-empty>No objections have been filed.</tas-empty>
      </div>
    }

    @for (summary of objections(); track summary.uuid; let first = $first) {
      <div class="tas-card" [style.margin-block-start]="first ? firstCardGap() : '1rem'">
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
              · admissibility {{ summary.admissibility | tasHumanise | lowercase }}
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
                    <th class="tas-amount">Disputed</th>
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
                  @if (holds('POST', '/api/v1/objections/:uuid/deposit')) {
                    <div class="tas-row" style="margin-block-start:0.5rem">
                      <input
                        id="dep-amount"
                        class="tas-input"
                        type="text"
                        inputmode="decimal"
                        aria-label="Deposit received"
                        placeholder="Amount received"
                        [(ngModel)]="depositAmount"
                      />
                      <button type="button" class="tas-btn" (click)="payDeposit(d.uuid)">
                        Record deposit
                      </button>
                    </div>
                  }
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

            @if (
              d.admissibility === 'PENDING' &&
              !holds('POST', '/api/v1/objections/:uuid/admissibility')
            ) {
              <p class="tas-muted">Awaiting a ruling on whether the objection will be heard.</p>
            } @else if (d.admissibility === 'PENDING') {
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
              @if (holds('POST', '/api/v1/objections/:uuid/opinions')) {
                <h4>Opinion</h4>
                <div class="tas-row">
                  <select [(ngModel)]="opinion" class="tas-btn" aria-label="My opinion">
                    <option value="ALLOW">Allow</option>
                    <option value="PARTLY_ALLOW">Partly allow</option>
                    <option value="REJECT">Reject</option>
                    <option value="ABSTAIN">Abstain</option>
                  </select>
                  <button type="button" class="tas-btn" (click)="giveOpinion(d.uuid)">
                    Record my opinion
                  </button>
                </div>
              }
              @if (holds('POST', '/api/v1/objections/:uuid/decision')) {
                <h4>Decision</h4>
                <div class="tas-field">
                  <label for="dec-reason">Decision reasons</label>
                  <textarea id="dec-reason" [(ngModel)]="decisionReason"></textarea>
                  <span class="tas-field__hint">
                    A decision without reasons cannot be appealed against intelligibly.
                  </span>
                </div>
                <div class="tas-row" style="margin-block-start:0.75rem">
                  <select [(ngModel)]="decision" class="tas-btn" aria-label="Decision">
                    <option value="ALLOWED">Allowed</option>
                    <option value="PARTLY_ALLOWED">Partly allowed</option>
                    <option value="REJECTED">Rejected</option>
                  </select>
                  <button type="button" class="tas-btn tas-btn--primary" (click)="decide(d.uuid)">
                    Decide
                  </button>
                </div>
              } @else {
                <p class="tas-muted">Admitted, and awaiting the objection officer's decision.</p>
              }
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
                  {{ forumLabel(appeal.forum_code) }}
                  @if (appeal.external_reference) {
                    <div class="tas-muted" style="font-size:0.8rem">
                      {{ appeal.external_reference }}
                    </div>
                  }
                </td>
                <td>{{ appeal.filed_on }}</td>
                <td><tas-status [status]="appeal.status" /></td>
                <td>{{ appeal.outcome ? (appeal.outcome | tasHumanise) : '—' }}</td>
                <td>
                  @if (appeal.implemented_at) {
                    Yes
                  } @else if (appeal.outcome && holds('POST', '/api/v1/appeals/:uuid/implement')) {
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

      @if (holds('POST', '/api/v1/cases/:id/appeals') && canAppealFrom(status)) {
        <h4>File an appeal</h4>
        <div class="tas-grid">
          <div class="tas-field">
            <label for="app-forum">Forum</label>
            <select id="app-forum" [(ngModel)]="forumCode">
              @for (item of forums(); track item.itemCode) {
                <option [value]="item.itemCode">{{ label(item) }}</option>
              }
            </select>
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
            [disabled]="busy() || forumCode === ''"
            (click)="fileAppeal()"
          >
            File appeal
          </button>
        </div>
      } @else if (holds('POST', '/api/v1/cases/:id/appeals') && appeals().length === 0) {
        <p class="tas-muted" style="margin-block-end:0">
          An appeal lies against a rejected objection, so it can be filed once the objection stage
          has decided against the taxpayer.
        </p>
      }

      @if (holds('POST', '/api/v1/appeals/:uuid/outcome') && undecided().length > 0) {
        <h4 style="margin-block-start:1.5rem">Record what the forum held</h4>
        <div class="tas-grid">
          <div class="tas-field">
            <label for="app-outcome-appeal">Appeal</label>
            <select id="app-outcome-appeal" [(ngModel)]="outcomeAppealUuid">
              @for (appeal of undecided(); track appeal.uuid) {
                <option [value]="appeal.uuid">
                  {{ appeal.appeal_number }} · {{ forumLabel(appeal.forum_code) }}
                </option>
              }
            </select>
          </div>
          <div class="tas-field">
            <label for="app-outcome">Outcome</label>
            <select id="app-outcome" [(ngModel)]="appealOutcome">
              <option value="UPHELD">Upheld (assessment stands)</option>
              <option value="VARIED">Varied</option>
              <option value="SET_ASIDE">Set aside</option>
              <option value="REMANDED">Remanded</option>
            </select>
          </div>
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
      }
    </div>
  `,
})
export class CaseDisputes implements OnInit {
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(I18nService);

  @Input({ required: true }) caseId!: number;
  @Input() status = '';
  /** The case's own jurisdiction, whose catalogues the server validates against. */
  @Input() jurisdiction = '';
  @Output() readonly changed = new EventEmitter<void>();

  readonly canObjectFrom = canObjectFrom;
  readonly canAppealFrom = canAppealFrom;

  readonly objections = signal<readonly ObjectionSummary[]>([]);
  readonly appeals = signal<readonly AppealSummary[]>([]);
  readonly grounds = signal<readonly MasterItem[]>([]);
  readonly forums = signal<readonly MasterItem[]>([]);
  /** An outcome is recorded once, so a decided appeal is not offered again. */
  readonly undecided = computed(() =>
    this.appeals().filter((appeal) => appeal.status !== 'DECIDED'),
  );
  readonly detail = signal<ObjectionDetail | null>(null);
  readonly deposit = signal<DepositPosition | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  groundsSummary = '';
  groundCode = '';
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
    await Promise.all([this.load(), this.loadCatalogues()]);
  }

  async load(): Promise<void> {
    try {
      this.objections.set(await this.assessment.objections(this.caseId));
      this.appeals.set(await this.assessment.appeals(this.caseId));
      const pending = this.undecided();
      if (!pending.some((appeal) => appeal.uuid === this.outcomeAppealUuid)) {
        this.outcomeAppealUuid = pending[0]?.uuid ?? '';
      }
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  /**
   * The grounds and forums this jurisdiction recognises.
   *
   * A free-text box accepted any string and left the officer to learn the
   * valid ones from the refusal. Each list is fetched only by someone who can
   * file against it, since nobody else is shown the form it feeds.
   */
  private async loadCatalogues(): Promise<void> {
    try {
      if (this.holds('POST', '/api/v1/cases/:id/objections')) {
        const group = await this.assessment.masterCodes('OBJECTION_GROUND', this.jurisdiction);
        this.grounds.set(group.items);
        this.groundCode = group.items[0]?.itemCode ?? '';
      }
      if (this.holds('POST', '/api/v1/cases/:id/appeals')) {
        const group = await this.assessment.masterCodes('APPEAL_FORUM', this.jurisdiction);
        this.forums.set(group.items);
        this.forumCode = group.items[0]?.itemCode ?? '';
      }
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

  /** A forum by its configured name where the list is loaded, else its code. */
  forumLabel(code: string): string {
    const item = this.forums().find((forum) => forum.itemCode === code);
    return item === undefined ? code : this.label(item);
  }

  /**
   * Whether the filing card is shown at all.
   *
   * To someone who may file: the form when the status allows it, and before
   * that a line saying when it will. Once an objection is on file the card
   * has nothing left to say, and a note explaining why the form is absent
   * would sit above the objection it is absent because of.
   */
  showFiling(): boolean {
    return (
      this.holds('POST', '/api/v1/cases/:id/objections') &&
      (canObjectFrom(this.status) || this.objections().length === 0)
    );
  }

  /** The first card sits flush when the filing card above it is not shown. */
  firstCardGap(): string | null {
    return this.showFiling() ? '1rem' : null;
  }

  async openObjection(uuid: string): Promise<void> {
    if (this.detail()?.uuid === uuid) {
      this.detail.set(null);
      return;
    }
    this.error.set(null);
    try {
      this.detail.set(await this.assessment.objection(uuid));
      this.deposit.set(
        this.holds('GET', '/api/v1/objections/:uuid/deposit')
          ? await this.assessment.depositPosition(uuid)
          : null,
      );
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
