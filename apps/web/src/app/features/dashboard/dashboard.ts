import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { AssessmentService } from '../../core/assessment.service';
import type {
  DashboardSummary,
  DashboardWorkload,
  SlaPosition,
  ThroughputPoint,
} from '../../core/domain';
import { formatAmount, humanise } from '../../core/domain';
import { Chart } from '../../shared/chart';
import { AmountPipe, EmptyState, ErrorAlert, HumanisePipe, describeError } from '../../shared/ui';

/**
 * The assessment dashboard.
 *
 * Plan reference: V2 section 18.1 screen 2, section 21.3.
 *
 * ## Scoped, and it says so
 *
 * Every figure here is the caller's. An assessor sees their own cases, a
 * supervisor the team's. The screen states that in one line, because a
 * dashboard whose scope is invisible is a dashboard people quote in meetings
 * without knowing what it counted.
 *
 * ## Assessed and collected are never added together
 *
 * They are two tiles, side by side, with different labels. Assessed is what
 * was determined; collected is what arrived. A single "revenue" figure that
 * blurs them is the fastest route to a wrong number in a briefing.
 *
 * ## The charts are pictures; the tiles are the figures
 *
 * A bar cannot be exact, so the exact strings are always on the page next to
 * the chart that approximates them.
 */
@Component({
  selector: 'tas-dashboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, Chart, AmountPipe, HumanisePipe, EmptyState, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Dashboard</h1>
        <p class="tas-muted">
          Everything on this page is scoped to what you may see. An assessor sees their own cases;
          oversight roles see the whole register.
        </p>
      </div>
      <button type="button" class="tas-btn" [disabled]="loading()" (click)="load()">Refresh</button>
    </div>

    <tas-error [message]="error()" />

    @if (loading()) {
      <p class="tas-muted">Loading…</p>
    } @else if (summary(); as figures) {
      <div class="tas-tiles">
        <a class="tas-tile" routerLink="/cases">
          <span class="tas-tile__value">{{ figures.open_cases }}</span>
          <span class="tas-tile__label">Open cases</span>
        </a>
        <a class="tas-tile" routerLink="/queues">
          <span class="tas-tile__value">{{ figures.in_preparation }}</span>
          <span class="tas-tile__label">In preparation</span>
        </a>
        <a class="tas-tile" routerLink="/queues">
          <span class="tas-tile__value">{{ figures.awaiting_review }}</span>
          <span class="tas-tile__label">Awaiting review</span>
        </a>
        <a class="tas-tile" routerLink="/queues">
          <span class="tas-tile__value">{{ figures.awaiting_approval }}</span>
          <span class="tas-tile__label">Awaiting approval</span>
        </a>
        <a class="tas-tile" routerLink="/disputes">
          <span class="tas-tile__value">{{ figures.in_dispute }}</span>
          <span class="tas-tile__label">In dispute</span>
        </a>
        <div class="tas-tile">
          <span class="tas-tile__value">{{ figures.finalised_this_month }}</span>
          <span class="tas-tile__label">Finalised this month</span>
        </div>

        <!-- Two tiles, never one. See the class note. -->
        <div class="tas-tile tas-tile--wide">
          <span class="tas-tile__value tas-amount">{{ figures.net_assessed | tasAmount }}</span>
          <span class="tas-tile__label">Net assessed {{ figures.currencies ?? '' }}</span>
        </div>
        <div class="tas-tile tas-tile--wide">
          <span class="tas-tile__value tas-amount">{{ figures.collected | tasAmount }}</span>
          <span class="tas-tile__label">Collected {{ figures.currencies ?? '' }}</span>
        </div>

        <div
          class="tas-tile"
          [class.tas-tile--alarm]="figures.overdue_deadlines > 0"
          [attr.aria-live]="figures.overdue_deadlines > 0 ? 'polite' : null"
        >
          <span class="tas-tile__value">{{ figures.overdue_deadlines }}</span>
          <span class="tas-tile__label">Statutory deadlines overdue</span>
        </div>
        <div class="tas-tile" [class.tas-tile--warn]="figures.deadlines_this_week > 0">
          <span class="tas-tile__value">{{ figures.deadlines_this_week }}</span>
          <span class="tas-tile__label">Due within seven days</span>
        </div>
      </div>

      <div class="tas-dash-grid">
        <div class="tas-card">
          <h2>Open cases by status</h2>
          @if (statusSeries().length === 0) {
            <tas-empty>No open cases.</tas-empty>
          } @else {
            <tas-chart
              type="bar"
              [horizontal]="true"
              [series]="[{ name: 'Cases', data: statusSeries() }]"
              [labels]="statusLabels()"
              [height]="300"
            />
          }
        </div>

        <div class="tas-card">
          <h2>How long they have been open</h2>
          <p class="tas-muted">
            The last band is the one that matters: a case open longer than ninety days is usually
            waiting on somebody rather than being worked.
          </p>
          @if (ageSeries().length === 0) {
            <tas-empty>No open cases.</tas-empty>
          } @else {
            <tas-chart type="donut" [series]="ageSeries()" [labels]="ageLabels()" [height]="300" />
          }
        </div>

        <div class="tas-card tas-card--full">
          <h2>Finalised per month</h2>
          <p class="tas-muted">
            Counts, with the value they carried under the cursor. Months with no work finalised are
            shown as zero rather than left out.
          </p>
          <tas-chart
            type="bar"
            [series]="[{ name: 'Finalised', data: throughputCounts() }]"
            [labels]="throughputLabels()"
            [tooltipFormatter]="throughputTooltip"
            [height]="260"
          />
        </div>
      </div>

      <div class="tas-dash-grid">
        <div class="tas-card">
          <h2>Service levels</h2>
          <p class="tas-muted">
            Internal promises. Missing one is a management problem, not a legal one.
          </p>
          @if (sla()?.service?.length) {
            <table class="tas-table">
              <thead>
                <tr>
                  <th>Clock</th>
                  <th>On track</th>
                  <th>Overdue</th>
                  <th>Breached</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                @for (row of sla()!.service; track row.slaCode) {
                  <tr>
                    <td>{{ row.slaCode | tasHumanise }}</td>
                    <td>{{ row.onTrack }}</td>
                    <td [class.tas-amount--negative]="row.overdue > 0">{{ row.overdue }}</td>
                    <td [class.tas-amount--negative]="row.breached > 0">{{ row.breached }}</td>
                    <td>{{ row.completed }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <tas-empty>No service-level clocks are running on your cases.</tas-empty>
          }
        </div>

        <div class="tas-card">
          <h2>Statutory deadlines, next fortnight</h2>
          <p class="tas-muted">
            Set by law rather than by us. Missing one can make an assessment unenforceable.
          </p>
          @if (sla()?.statutory?.length) {
            <table class="tas-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Deadline</th>
                  <th>Due</th>
                  <th style="text-align:end">Days</th>
                </tr>
              </thead>
              <tbody>
                @for (row of sla()!.statutory; track row.caseNumber + row.deadlineType) {
                  <tr>
                    <td>
                      <a [routerLink]="['/cases', row.caseId]">{{ row.caseNumber }}</a>
                    </td>
                    <td>{{ row.deadlineType | tasHumanise }}</td>
                    <td>{{ row.dueAt | date: 'yyyy-MM-dd' }}</td>
                    <td class="tas-amount" [class.tas-amount--negative]="row.daysRemaining < 0">
                      {{ row.daysRemaining }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <tas-empty>Nothing falls due in the next fortnight.</tas-empty>
          }
        </div>
      </div>
    } @else {
      <tas-empty>Nothing to show. You may not have any cases yet.</tas-empty>
    }
  `,
  styles: [
    `
      .tas-tiles {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        gap: 0.75rem;
        margin-block-end: 1.25rem;
      }
      .tas-tile {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        padding: 0.9rem 1rem;
        border: 1px solid var(--tas-border, #e2e8f0);
        border-radius: 8px;
        background: var(--tas-surface, #fff);
        text-decoration: none;
        color: inherit;
      }
      a.tas-tile:hover {
        border-color: #2563eb;
      }
      .tas-tile--wide {
        grid-column: span 2;
      }
      .tas-tile__value {
        font-size: 1.5rem;
        font-weight: 600;
      }
      .tas-tile__label {
        font-size: 0.8rem;
        color: var(--tas-muted, #64748b);
      }
      .tas-tile--warn {
        border-color: #d97706;
      }
      .tas-tile--alarm {
        border-color: #dc2626;
      }
      .tas-dash-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: 1rem;
        margin-block-end: 1rem;
      }
      .tas-card--full {
        grid-column: 1 / -1;
      }
    `,
  ],
})
export class Dashboard implements OnInit {
  private readonly assessment = inject(AssessmentService);

  readonly summary = signal<DashboardSummary | null>(null);
  readonly workload = signal<DashboardWorkload | null>(null);
  readonly throughput = signal<readonly ThroughputPoint[]>([]);
  readonly sla = signal<SlaPosition | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly statusLabels = computed(() =>
    (this.workload()?.byStatus ?? []).map((row) => humanise(row.statusCode)),
  );
  readonly statusSeries = computed(() => (this.workload()?.byStatus ?? []).map((row) => row.count));

  readonly ageLabels = computed(() => (this.workload()?.byAge ?? []).map((row) => row.band));
  readonly ageSeries = computed(() => (this.workload()?.byAge ?? []).map((row) => row.count));

  readonly throughputLabels = computed(() => this.throughput().map((point) => point.month));
  readonly throughputCounts = computed(() => this.throughput().map((point) => point.finalised));

  /**
   * The exact value behind each bar.
   *
   * The bar is a count; the money is shown as the string the server sent,
   * never as a rounded chart value.
   */
  readonly throughputTooltip = (value: number, index: number): string => {
    const point = this.throughput()[index];
    const amount = point === undefined ? '0' : formatAmount(point.netAssessed);
    return `${value} finalised · ${amount} assessed`;
  };

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      // In parallel: four independent reads, and a dashboard that waited for
      // each in turn would take four round trips to draw.
      const [summary, workload, throughput, sla] = await Promise.all([
        this.assessment.dashboardSummary(),
        this.assessment.dashboardWorkload(),
        this.assessment.dashboardThroughput(12),
        this.assessment.dashboardSla(),
      ]);
      this.summary.set(summary);
      this.workload.set(workload);
      this.throughput.set(throughput);
      this.sla.set(sla);
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.loading.set(false);
    }
  }
}
