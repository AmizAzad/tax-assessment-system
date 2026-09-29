import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AssessmentService } from '../../core/assessment.service';
import { AuthService } from '../../core/auth.service';
import type { AssessmentCase } from '../../core/domain';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../shared/ui';

interface Queue {
  readonly id: string;
  readonly label: string;
  readonly statuses: readonly string[];
  readonly blurb: string;
  readonly roles?: readonly string[];
}

/**
 * Work queues.
 *
 * Plan reference: V2 sections 9.1, 9.2.
 *
 * ## Why queues are a view of the register and not their own tables
 *
 * A queue is "cases in these statuses that I can see". The register endpoint
 * already applies the caller's scope, so a queue is one filtered call. Giving
 * each queue its own table would mean a second place where scope is decided,
 * and two places that decide who sees what will eventually disagree.
 *
 * ## Why every queue is shown, not only the ones for my role
 *
 * A queue with nothing in it for you still tells you the work exists and who
 * has it. Hiding the approval queue from an assessor makes the process opaque
 * to the person whose work is in it.
 */
@Component({
  selector: 'tas-queues',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Work queues</h1>
        <p class="tas-muted">
          Each queue is the register filtered by stage, scoped to what you may see.
        </p>
      </div>
      <button type="button" class="tas-btn" (click)="load()">Refresh</button>
    </div>

    <tas-error [message]="error()" />

    <nav class="tas-tabs" role="tablist">
      @for (queue of queues; track queue.id) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="active() === queue.id"
          (click)="select(queue.id)"
        >
          {{ queue.label }}
          @if (counts()[queue.id] !== undefined) {
            <span class="tas-badge" style="margin-inline-start:0.4rem">{{
              counts()[queue.id]
            }}</span>
          }
        </button>
      }
    </nav>

    @if (current(); as queue) {
      <div class="tas-card">
        <h2 style="margin-top:0">{{ queue.label }}</h2>
        <p class="tas-muted">{{ queue.blurb }}</p>

        @if (loading()) {
          <p class="tas-muted">Loading…</p>
        } @else if (rows().length === 0) {
          <tas-empty>Nothing waiting in this queue.</tas-empty>
        } @else {
          <table class="tas-table">
            <thead>
              <tr>
                <th>Case</th>
                <th>Taxpayer</th>
                <th>Period</th>
                <th>Status</th>
                <th class="tas-amount">Net payable</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track row.id) {
                <tr>
                  <td>
                    <a [routerLink]="['/cases', row.id]">{{ row.caseNumber }}</a>
                  </td>
                  <td>
                    {{ row.taxpayerName }}
                    <div class="tas-muted" style="font-size:0.8rem">{{ row.tin }}</div>
                  </td>
                  <td>{{ row.taxTypeCode }} {{ row.assessmentYear }}</td>
                  <td><tas-status [status]="row.statusCode" /></td>
                  <td class="tas-amount">
                    {{ row.netPayable | tasAmount }} {{ row.currencyCode }}
                  </td>
                  <td class="tas-muted">{{ row.openedAt | date: 'yyyy-MM-dd' }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
    }
  `,
})
export class Queues implements OnInit {
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);

  readonly rows = signal<readonly AssessmentCase[]>([]);
  readonly counts = signal<Record<string, number>>({});
  readonly error = signal<string | null>(null);
  readonly loading = signal(false);
  readonly active = signal('preparation');

  readonly queues: readonly Queue[] = [
    {
      id: 'preparation',
      label: 'In preparation',
      statuses: ['ASSIGNED', 'IN_PREPARATION', 'CALCULATED', 'REVIEW_RETURNED', 'REJECTED'],
      blurb: 'Cases being worked. A returned or rejected case comes back here for rework.',
    },
    {
      id: 'review',
      label: 'Awaiting review',
      statuses: ['UNDER_REVIEW'],
      blurb: 'Submitted for review. The reviewer may not be the officer who prepared the case.',
    },
    {
      id: 'approval',
      label: 'Awaiting approval',
      statuses: ['REVIEWED', 'PENDING_APPROVAL'],
      blurb: 'Routed by amount to the approver the delegation limits require.',
    },
    {
      id: 'notice',
      label: 'To notify',
      statuses: ['FINALISED', 'NOTICE_GENERATED'],
      blurb: 'Finalised assessments awaiting a notice, and notices awaiting service.',
    },
    {
      id: 'response',
      label: 'With the taxpayer',
      statuses: ['NOTICE_SERVED', 'AWAITING_TAXPAYER_RESPONSE', 'AWAITING_TAXPAYER'],
      blurb: 'Served, and inside the objection window or awaiting information.',
    },
    {
      id: 'disputes',
      label: 'In dispute',
      statuses: ['UNDER_OBJECTION', 'UNDER_APPEAL', 'OBJECTION_REJECTED'],
      blurb: 'Objections and appeals in progress.',
    },
    {
      id: 'intake',
      label: 'New',
      statuses: ['INITIATED', 'DATA_READY'],
      blurb: 'Opened but not yet assigned. Evidence retrieval is what makes one data-ready.',
    },
  ];

  current(): Queue | undefined {
    return this.queues.find((queue) => queue.id === this.active());
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async select(id: string): Promise<void> {
    this.active.set(id);
    await this.loadCurrent();
  }

  async load(): Promise<void> {
    await this.loadCurrent();
    await this.loadCounts();
  }

  private async loadCurrent(): Promise<void> {
    const queue = this.current();
    if (queue === undefined) return;

    this.loading.set(true);
    this.error.set(null);
    try {
      this.rows.set(await this.fetch(queue));
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Counts for the tabs.
   *
   * Loaded after the visible queue so the screen is usable immediately. The
   * register has no count-by-status endpoint, so each queue is one call; at
   * seven queues that is acceptable, and a dedicated endpoint would be the fix
   * if the register grows to where it is not.
   */
  private async loadCounts(): Promise<void> {
    const counts: Record<string, number> = {};
    for (const queue of this.queues) {
      try {
        counts[queue.id] = (await this.fetch(queue)).length;
      } catch {
        // A queue whose count cannot be read should not blank the others.
      }
    }
    this.counts.set(counts);
  }

  /**
   * One call per status in the queue.
   *
   * The register filters on a single status, so a multi-status queue is the
   * union of its statuses. Deduplicated by case id because a case cannot be in
   * two statuses but a concurrent transition between calls could return it
   * twice.
   */
  private async fetch(queue: Queue): Promise<readonly AssessmentCase[]> {
    const seen = new Map<number, AssessmentCase>();
    for (const status of queue.statuses) {
      const result = await this.assessment.searchCases({ status, pageSize: 100 });
      for (const row of result.rows) seen.set(row.id, row);
    }
    return [...seen.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  hasRole(...roles: string[]): boolean {
    return this.auth.hasRole(...roles);
  }
}
