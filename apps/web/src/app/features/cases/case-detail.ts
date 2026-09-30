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
import { CaseStatus, findTransition } from '@tas/contracts';
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

/**
 * Transitions the state machine gives to SYSTEM that an officer asks for.
 *
 * Their actor list names no human role, because the service decides the
 * outcome, so whether to offer the button is the question of who may call the
 * service route that performs them.
 */
const SERVICE_ACTIONS: Readonly<Record<string, string>> = {
  ROUTE_APPROVAL: '/api/v1/cases/:id/route-approval',
  FINALISE: '/api/v1/cases/:id/finalise',
};

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
 * ## Why the actions are read off the transition table, role and all
 *
 * The buttons offered are the transitions the state machine defines from the
 * current status whose actors include a role the caller holds. The server
 * still decides — segregation of duties and the approval band are checked
 * there and nowhere else — and a refused action shows the server's own
 * message, because "requires TA_APPROVER_L2" tells somebody what to do next
 * and "Forbidden" does not.
 *
 * Offering every status's actions to every role was the earlier design. It
 * put Approve in front of the assessor who wrote the case and Finalise in
 * front of the notice issuer, each a button the server refused every time,
 * which teaches officers that errors are the normal response to a click.
 *
 * ## Why tabs are shown by permission
 *
 * Each tab reads its own route. A role the catalogue does not grant that
 * route saw the tab, opened it, and got a red "Insufficient permissions" in
 * place of the content — a notice issuer has no business reading the
 * adjustments, and the screen now agrees with the server about that.
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

      <!--
        Lifecycle actions. Every one is re-checked by the server. Kept on
        screen after the last action this officer may take, while it carries
        the service's note: routing for approval leaves the reviewer nothing
        more to press, and the sentence saying which band it chose is the
        answer to "why me" when the case lands on an approver.
      -->
      @if (permittedActions().length > 0 || actionNote()) {
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
              Cancelling, returning, rejecting and writing off each go against
              the taxpayer or against work already done, so the transition
              table marks them as needing a reason and the field appears
              wherever one of them is on offer. The reason travels on the
              transition payload onto the ledger event, because the file has to
              say on whose judgement the case turned.
            -->
            @if (reasonRequired()) {
              <div class="tas-field" style="flex-direction:row; align-items:center; gap:0.4rem">
                <label for="transition-reason">Reason</label>
                <input id="transition-reason" [(ngModel)]="reason" style="width:11rem" />
              </div>
            }

            @if (permittedActions().length === 0) {
              <span class="tas-muted" style="font-size:0.85rem">Nothing further for you here.</span>
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
                  (action.requiresReason && reason.trim() === '')
                "
                (click)="act(action.code)"
                [title]="action.hint"
              >
                {{ action.label }}
              </button>
            }
          </div>
          @if (actionNote(); as note) {
            <p class="tas-muted tas-action-note" role="status" style="margin-block-start:0.75rem">
              {{ note }}
            </p>
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
        @for (tab of visibleTabs(); track tab.id) {
          <button
            type="button"
            role="tab"
            [id]="'tab-' + tab.id"
            [attr.aria-selected]="shown() === tab.id"
            [attr.aria-controls]="'panel-' + tab.id"
            [attr.tabindex]="shown() === tab.id ? 0 : -1"
            (click)="active.set(tab.id)"
          >
            {{ tab.label }}
          </button>
        }
      </nav>

      <div
        role="tabpanel"
        [id]="'panel-' + shown()"
        [attr.aria-labelledby]="'tab-' + shown()"
        tabindex="0"
      >
        @switch (shown()) {
          @case ('evidence') {
            <tas-case-evidence
              [caseId]="c.id"
              [status]="c.statusCode"
              [canRetrieve]="canSee('POST', '/api/v1/cases/:id/evidence/refresh')"
              (changed)="reload()"
            />
          }
          @case ('adjustments') {
            <tas-case-adjustments
              [caseId]="c.id"
              [status]="c.statusCode"
              [currency]="c.currencyCode"
              [canRecord]="canSee('POST', '/api/v1/cases/:id/adjustments')"
              (changed)="reload()"
            />
          }
          @case ('calculation') {
            <tas-case-calculation
              [caseId]="c.id"
              [status]="c.statusCode"
              [canCalculate]="canSee('POST', '/api/v1/cases/:id/calculate')"
              (changed)="reload()"
            />
          }
          @case ('schedule') {
            <tas-case-schedule [caseId]="c.id" />
          }
          @case ('notices') {
            <tas-case-notices [caseId]="c.id" [status]="c.statusCode" (changed)="reload()" />
          }
          @case ('disputes') {
            <tas-case-disputes
              [caseId]="c.id"
              [status]="c.statusCode"
              [jurisdiction]="c.jurisdictionCode"
              (changed)="reload()"
            />
          }
          @case ('closure') {
            <tas-case-closure
              [caseId]="c.id"
              [status]="c.statusCode"
              [taxpayerId]="c.taxpayerId"
              [taxTypeCode]="c.taxTypeCode"
              [assessmentYear]="c.assessmentYear"
              [currency]="c.currencyCode"
              [jurisdiction]="c.jurisdictionCode"
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
  reason = '';

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

    const tabs = this.visibleTabs();
    const index = tabs.findIndex((tab) => tab.id === this.shown());
    const last = tabs.length - 1;

    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowLeft'
            ? (index - 1 + tabs.length) % tabs.length
            : (index + 1) % tabs.length;

    this.active.set(tabs[next]!.id);

    // The button has to receive focus as well as selection, or the next
    // arrow press is handled by whatever the browser still thinks is focused.
    queueMicrotask(() => {
      document.getElementById(`tab-${tabs[next]!.id}`)?.focus();
    });
  }

  /**
   * Each tab and the routes it reads on opening.
   *
   * Literal catalogue keys, because that is what `/me` returns. A tab needing
   * two reads needs both: the panel loads them together, and one refusal
   * would blank the half that was allowed.
   */
  private readonly tabs: readonly { id: TabId; label: string; reads: readonly string[] }[] = [
    { id: 'evidence', label: 'Evidence', reads: ['/api/v1/cases/:id/evidence'] },
    {
      id: 'adjustments',
      label: 'Adjustments',
      reads: ['/api/v1/cases/:id/adjustments'],
    },
    {
      id: 'calculation',
      label: 'Calculation',
      reads: ['/api/v1/cases/:id/calculation', '/api/v1/cases/:id/calculation/history'],
    },
    {
      id: 'schedule',
      label: 'Deadlines & SLA',
      reads: ['/api/v1/cases/:id/deadlines/recorded', '/api/v1/cases/:id/sla'],
    },
    { id: 'notices', label: 'Notices', reads: ['/api/v1/cases/:id/notices'] },
    {
      id: 'disputes',
      label: 'Disputes',
      reads: ['/api/v1/cases/:id/objections', '/api/v1/cases/:id/appeals'],
    },
    {
      id: 'closure',
      label: 'Closure',
      reads: ['/api/v1/cases/:id/lineage', '/api/v1/cases/:id/reassessments'],
    },
    { id: 'journey', label: 'Journey', reads: ['/api/v1/processes/cases/:id/journey'] },
    { id: 'timeline', label: 'Timeline', reads: ['/api/v1/cases/:id/timeline'] },
  ];

  readonly visibleTabs = computed(() => {
    // Recomputes when the caller lands, so a deep link opened before `/me`
    // answers does not freeze on an empty tab list.
    this.auth.caller();
    return this.tabs.filter((tab) => tab.reads.every((path) => this.canSee('GET', path)));
  });

  /** The selected tab, or the first one this caller may open. */
  readonly shown = computed<TabId | null>(() => {
    const tabs = this.visibleTabs();
    return tabs.some((tab) => tab.id === this.active()) ? this.active() : (tabs[0]?.id ?? null);
  });

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
      // Cancellation belongs to INITIATED alone, which is what the transition
      // table and plan section 10.2 row 3 both say. Offering it here produced
      // a button the server always refused, and with the engine coordinating
      // a case reaches DATA_READY in about a second, so it was the only
      // Cancel most officers ever saw.
      DATA_READY: [{ code: 'ASSIGN', label: 'Assign', hint: 'Supervisor only', primary: true }],
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
    if (status === undefined) return [];
    const held = this.auth.caller()?.roleCodes ?? [];

    // Who may act, and whether they must say why, are both the state
    // machine's answers, read off the same row the server validates against.
    // Restating either here would give the officer and the server two rules
    // to disagree about. The status arrives from the API as the enum's own
    // value, which is why the lookup takes it as one.
    return (table[status] ?? []).flatMap((action) => {
      const transition = findTransition({ from: status as CaseStatus, action: action.code });
      if (transition === undefined) return [];

      const service = SERVICE_ACTIONS[action.code];
      const offered =
        service !== undefined
          ? this.canSee('POST', service)
          : this.canSee('POST', '/api/v1/cases/:id/transition') &&
            transition.actors.some((role) => held.includes(role));
      return offered ? [{ ...action, requiresReason: transition.requiresReason }] : [];
    });
  });

  /** Whether any action on offer needs a reason, so the field is shown. */
  readonly reasonRequired = computed(() =>
    this.permittedActions().some((action) => action.requiresReason),
  );

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
          : this.permittedActions().some((a) => a.code === action && a.requiresReason)
            ? { reason: this.reason.trim() }
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
