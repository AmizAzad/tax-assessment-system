import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AssessmentService } from '../../core/assessment.service';
import { AuthService } from '../../core/auth.service';
import type { AssessmentCase } from '../../core/domain';
import { AmountPipe, ErrorAlert, StatusBadge, describeError } from '../../shared/ui';
import { CaseAdjustments } from './tabs/adjustments-tab';
import { CaseCalculation } from './tabs/calculation-tab';
import { CaseDisputes } from './tabs/disputes-tab';
import { CaseEvidence } from './tabs/evidence-tab';
import { CaseNotices } from './tabs/notices-tab';
import { CaseSchedule } from './tabs/schedule-tab';
import { CaseTimeline } from './tabs/timeline-tab';
import { CaseClosure } from './tabs/closure-tab';
import { CaseJourney } from './tabs/journey-tab';

type TabId =
  | 'evidence'
  | 'adjustments'
  | 'calculation'
  | 'schedule'
  | 'notices'
  | 'disputes'
  | 'closure'
  | 'journey'
  | 'timeline';

/**
 * The assessment workbench.
 *
 * Plan reference: V2 sections 9.2, 9.3.
 *
 * ## Why the actions are computed from the case, not from the role
 *
 * The buttons offered come from `permittedActions`, which is derived from the
 * status. The server still decides: every one of them is refused by the
 * transition table if the caller's role does not hold it, and the refusal
 * message says which role does. Hiding a button is a courtesy to the officer,
 * never the control.
 *
 * That is why a refused action shows the server's own message rather than a
 * generic failure. "Action ACCEPT requires one of [TA_REVIEWER]; caller holds
 * [TA_ASSESSOR]" tells somebody what to do next; "Forbidden" does not.
 */
@Component({
  selector: 'tas-case-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    RouterLink,
    DatePipe,
    StatusBadge,
    AmountPipe,
    ErrorAlert,
    CaseEvidence,
    CaseAdjustments,
    CaseCalculation,
    CaseSchedule,
    CaseNotices,
    CaseDisputes,
    CaseClosure,
    CaseJourney,
    CaseTimeline,
  ],
  template: `
    <tas-error [message]="error()" />

    @if (assessmentCase(); as c) {
      <div class="tas-page-head">
        <div>
          <p class="tas-muted" style="margin:0 0 0.25rem"><a routerLink="/cases">Register</a> ›</p>
          <h1 style="display:flex; align-items:center; gap:0.75rem">
            {{ c.caseNumber }}
            <tas-status [status]="c.statusCode" />
          </h1>
          <p class="tas-muted" style="margin:0.25rem 0 0">
            {{ c.taxpayerName }} · {{ c.tin }} · {{ c.taxTypeCode }} {{ c.assessmentYear }} ·
            {{ c.jurisdictionCode }}
          </p>
        </div>
        <dl class="tas-facts" style="min-width:18rem">
          <div>
            <dt>Net payable</dt>
            <dd class="tas-amount">{{ c.netPayable | tasAmount }} {{ c.currencyCode }}</dd>
          </div>
          <div>
            <dt>Opened</dt>
            <dd>{{ c.openedAt | date: 'yyyy-MM-dd' }}</dd>
          </div>
          <div>
            <dt>Limitation</dt>
            <dd>{{ c.limitationDate ?? '—' }}</dd>
          </div>
        </dl>
      </div>

      <!-- Lifecycle actions. Every one is re-checked by the server. -->
      @if (permittedActions().length > 0) {
        <div class="tas-card" style="margin-block-end:1rem">
          <div class="tas-row">
            <strong style="font-size:0.85rem">Actions</strong>

            <!--
              Assigning names somebody. The server refuses an ASSIGN that does
              not, because a case that says it is assigned and appears in
              nobody's register is worse than one still waiting to be given out.
            -->
            @if (canAssign()) {
              <label class="tas-field" style="flex-direction:row; align-items:center; gap:0.4rem">
                <span style="font-size:0.85rem">Assign to</span>
                <input
                  id="assignee"
                  [(ngModel)]="assignee"
                  placeholder="assessor"
                  style="width:11rem"
                />
              </label>
            }

            <!--
              Writing off abandons the debt. The reason travels on the
              transition payload onto the ledger event, because the file has to
              say on whose judgement the money stopped being owed.
            -->
            @if (canWriteOff()) {
              <div class="tas-field" style="flex-direction:row; align-items:center; gap:0.4rem">
                <label for="write-off-reason">Reason</label>
                <input id="write-off-reason" [(ngModel)]="writeOffReason" style="width:11rem" />
              </div>
            }

            @for (action of permittedActions(); track action.code) {
              <button
                type="button"
                class="tas-btn"
                [class.tas-btn--primary]="action.primary"
                [class.tas-btn--danger]="action.danger"
                [disabled]="
                  busy() ||
                  (action.code === 'ASSIGN' && assignee.trim() === '') ||
                  (action.code === 'WRITE_OFF' && writeOffReason.trim() === '')
                "
                (click)="act(action.code)"
                [title]="action.hint"
              >
                {{ action.label }}
              </button>
            }
          </div>
          @if (actionNote(); as note) {
            <p class="tas-muted" style="margin-block-start:0.75rem">{{ note }}</p>
          }
        </div>
      }

      <!--
        A tab list, done properly: one stop in the tab order, arrow keys to
        move between tabs, Home and End to jump. A row of buttons that each
        take a tab stop makes an officer press Tab eight times to reach the
        content (plan 18.3, WCAG 2.1 AA).
      -->
      <nav class="tas-tabs" role="tablist" aria-label="Case sections" (keydown)="onTabKey($event)">
        @for (tab of tabs; track tab.id) {
          <button
            type="button"
            role="tab"
            [id]="'tab-' + tab.id"
            [attr.aria-selected]="active() === tab.id"
            [attr.aria-controls]="'panel-' + tab.id"
            [attr.tabindex]="active() === tab.id ? 0 : -1"
            (click)="active.set(tab.id)"
          >
            {{ tab.label }}
          </button>
        }
      </nav>

      <div
        role="tabpanel"
        [id]="'panel-' + active()"
        [attr.aria-labelledby]="'tab-' + active()"
        tabindex="0"
      >
        @switch (active()) {
          @case ('evidence') {
            <tas-case-evidence [caseId]="c.id" [status]="c.statusCode" (changed)="reload()" />
          }
          @case ('adjustments') {
            <tas-case-adjustments
              [caseId]="c.id"
              [currency]="c.currencyCode"
              (changed)="reload()"
            />
          }
          @case ('calculation') {
            <tas-case-calculation [caseId]="c.id" [status]="c.statusCode" (changed)="reload()" />
          }
          @case ('schedule') {
            <tas-case-schedule [caseId]="c.id" />
          }
          @case ('notices') {
            <tas-case-notices [caseId]="c.id" [status]="c.statusCode" (changed)="reload()" />
          }
          @case ('disputes') {
            <tas-case-disputes [caseId]="c.id" [status]="c.statusCode" (changed)="reload()" />
          }
          @case ('closure') {
            <tas-case-closure
              [caseId]="c.id"
              [status]="c.statusCode"
              [taxpayerId]="c.taxpayerId"
              [taxTypeCode]="c.taxTypeCode"
              [assessmentYear]="c.assessmentYear"
              [currency]="c.currencyCode"
              (changed)="reload()"
            />
          }
          @case ('journey') {
            <tas-case-journey [caseId]="c.id" />
          }
          @case ('timeline') {
            <tas-case-timeline [caseId]="c.id" />
          }
        }
      </div>
    } @else if (!error()) {
      <p class="tas-muted">Loading…</p>
    }
  `,
})
export class CaseDetail implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);

  readonly assessmentCase = signal<AssessmentCase | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly active = signal<TabId>('evidence');
  readonly actionNote = signal<string | null>(null);

  /** Who the case is being assigned to. Defaulted, never assumed server-side. */
  assignee = 'assessor';
  writeOffReason = '';

  /**
   * Arrow-key navigation across the tabs.
   *
   * The pattern a screen-reader user expects from a tab list, and the one an
   * officer working by keyboard gets from every other application. Left and
   * right move; Home and End jump to the ends. Focus follows selection, so
   * the panel content is the next thing reached.
   */
  onTabKey(event: KeyboardEvent): void {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) {
      return;
    }
    event.preventDefault();

    const index = this.tabs.findIndex((tab) => tab.id === this.active());
    const last = this.tabs.length - 1;

    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowLeft'
            ? (index - 1 + this.tabs.length) % this.tabs.length
            : (index + 1) % this.tabs.length;

    this.active.set(this.tabs[next]!.id);

    // The button has to receive focus as well as selection, or the next
    // arrow press is handled by whatever the browser still thinks is focused.
    queueMicrotask(() => {
      document.getElementById(`tab-${this.tabs[next]!.id}`)?.focus();
    });
  }

  readonly tabs: readonly { id: TabId; label: string }[] = [
    { id: 'evidence', label: 'Evidence' },
    { id: 'adjustments', label: 'Adjustments' },
    { id: 'calculation', label: 'Calculation' },
    { id: 'schedule', label: 'Deadlines & SLA' },
    { id: 'notices', label: 'Notices' },
    { id: 'disputes', label: 'Disputes' },
    { id: 'closure', label: 'Closure' },
    { id: 'journey', label: 'Journey' },
    { id: 'timeline', label: 'Timeline' },
  ];

  /**
   * What can be done from the current status.
   *
   * The bar mirrors the transition table's human actions, plus the two SYSTEM
   * transitions a permissioned service endpoint performs on the officer's
   * behalf. `ROUTE_APPROVAL` and `FINALISE` each have a button because the
   * officer asks for the step and the service decides its outcome. The rest of
   * the SYSTEM transitions are consequences of other acts, so they have none.
   */
  readonly permittedActions = computed(() => {
    const status = this.assessmentCase()?.statusCode;
    const table: Record<
      string,
      { code: string; label: string; hint: string; primary?: boolean; danger?: boolean }[]
    > = {
      DATA_READY: [
        { code: 'ASSIGN', label: 'Assign', hint: 'Supervisor only', primary: true },
        { code: 'CANCEL', label: 'Cancel', hint: 'Supervisor only' },
      ],
      INITIATED: [{ code: 'CANCEL', label: 'Cancel', hint: 'Supervisor only' }],
      ASSIGNED: [
        { code: 'START', label: 'Start preparation', hint: 'Assessor only', primary: true },
      ],
      IN_PREPARATION: [
        {
          code: 'REQUEST_INFO',
          label: 'Request information',
          hint: 'Pauses for the taxpayer to respond',
        },
      ],
      CALCULATED: [
        { code: 'SUBMIT', label: 'Submit for review', hint: 'Assessor only', primary: true },
      ],
      UNDER_REVIEW: [
        { code: 'ACCEPT', label: 'Accept', hint: 'Reviewer, and not the assessor', primary: true },
        { code: 'RETURN', label: 'Return for rework', hint: 'Reviewer only' },
      ],
      /**
       * The band comes from the configured delegation limits and the amount,
       * never from the caller, so the button asks the service to route rather
       * than naming an approver. Without it a reviewed case stopped dead.
       */
      REVIEWED: [
        {
          code: 'ROUTE_APPROVAL',
          label: 'Route for approval',
          hint: 'The band comes from the amount, not from you',
          primary: true,
        },
      ],
      REVIEW_RETURNED: [
        { code: 'START', label: 'Resume preparation', hint: 'Assessor only', primary: true },
      ],
      PENDING_APPROVAL: [
        {
          code: 'APPROVE',
          label: 'Approve',
          hint: 'Approver at the required level',
          primary: true,
        },
        { code: 'REJECT', label: 'Reject', hint: 'Approver at the required level' },
      ],
      REJECTED: [{ code: 'START', label: 'Rework', hint: 'Assessor only', primary: true }],
      APPROVED: [
        {
          code: 'FINALISE',
          label: 'Finalise',
          hint: 'Consumes the losses the calculation relied on',
          primary: true,
        },
      ],
      AWAITING_TAXPAYER: [
        { code: 'RESPOND', label: 'Record a response', hint: 'Returns the case to preparation' },
      ],
      AWAITING_TAXPAYER_RESPONSE: [
        {
          code: 'WRITE_OFF',
          label: 'Write off',
          hint: 'Supervisor only. Terminal: the debt is abandoned',
          danger: true,
        },
      ],
      REASSESSMENT_INITIATED: [
        { code: 'START', label: 'Start preparation', hint: 'Assessor only', primary: true },
      ],
    };
    return status === undefined ? [] : (table[status] ?? []);
  });

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const id = Number(this.route.snapshot.paramMap.get('id'));
    this.error.set(null);
    try {
      this.assessmentCase.set(await this.assessment.getCase(id));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  /** Whether the current status offers assignment, so the field is shown. */
  canAssign(): boolean {
    return this.permittedActions().some((action) => action.code === 'ASSIGN');
  }

  /** Whether the current status offers write-off, so the reason field is shown. */
  canWriteOff(): boolean {
    return this.permittedActions().some((action) => action.code === 'WRITE_OFF');
  }

  async act(action: string): Promise<void> {
    const current = this.assessmentCase();
    if (current === null) return;

    this.busy.set(true);
    this.error.set(null);
    this.actionNote.set(null);
    try {
      if (action === 'ROUTE_APPROVAL') {
        // A different endpoint, because it is a decision rather than a move:
        // the service picks the approval band and reports how it derived it.
        const routed = await this.assessment.routeForApproval(current.id);
        await this.reload();
        this.actionNote.set(routed.derivation);
        return;
      }

      if (action === 'FINALISE') {
        const finalised = await this.assessment.finalise(current.id);
        await this.reload();
        this.actionNote.set(`Finalised. Losses consumed: ${finalised.lossesConsumed}.`);
        return;
      }

      // The assignee travels with the action, so the status change and the
      // assignment are one transaction on the server.
      const payload =
        action === 'ASSIGN'
          ? { assigneeUsername: this.assignee.trim() }
          : action === 'WRITE_OFF'
            ? { reason: this.writeOffReason.trim() }
            : undefined;
      const updated = await this.assessment.transition(current.id, action, payload);
      this.assessmentCase.set(updated);
      this.actionNote.set(`Moved to ${updated.statusCode}.`);
    } catch (error) {
      // The server's own words: they name the role that may act, or the
      // actions permitted from here.
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  canSee(method: string, path: string): boolean {
    return this.auth.canInvoke(method, path);
  }
}
