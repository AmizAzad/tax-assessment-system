import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AssessmentService } from '../../core/assessment.service';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../shared/ui';

interface ReportDefinition {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  readonly columns: readonly { key: string; label: string; amount?: boolean; status?: boolean }[];
}

/**
 * Management reporting.
 *
 * Plan reference: V2 sections 21.1 to 21.4.
 *
 * ## Every figure arrives as a string and stays one
 *
 * The tables below render what the API returned without parsing. A pack that
 * summed in JavaScript would not tie back to the register it reports on, and a
 * management report that does not reconcile is worse than no report.
 *
 * ## Why reconciliation is last and looks different
 *
 * It is not a metric. Every row it returns is a defect in the register, and an
 * empty result is the expected answer, so it is presented as a check with a
 * verdict rather than as a table of numbers.
 */
@Component({
  selector: 'tas-reports',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Reports</h1>
        <p class="tas-muted">
          The whole register, unscoped. Amounts are rendered exactly as computed.
        </p>
      </div>
      <div class="tas-field">
        <label for="rep-jurisdiction">Jurisdiction</label>
        <input
          id="rep-jurisdiction"
          [(ngModel)]="jurisdiction"
          (change)="load()"
          placeholder="all"
        />
      </div>
    </div>

    <tas-error [message]="error()" />

    <nav class="tas-tabs" role="tablist">
      @for (report of reports; track report.id) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="active() === report.id"
          (click)="select(report.id)"
        >
          {{ report.label }}
        </button>
      }
      <button
        type="button"
        role="tab"
        [attr.aria-selected]="active() === 'reconciliation'"
        (click)="select('reconciliation')"
      >
        Reconciliation
      </button>
    </nav>

    @if (active() === 'reconciliation') {
      <div class="tas-card">
        <h2 style="margin-top:0">Where the register contradicts itself</h2>
        <p class="tas-muted">
          Every row is a defect, not a metric. An empty result is the expected answer.
        </p>
        @if (reconciliation(); as checks) {
          @for (check of objectKeys(checks); track check) {
            <div
              class="tas-alert"
              [class.tas-alert--danger]="checks[check].length > 0"
              style="margin-block-start:0.75rem"
            >
              <strong>{{ label(check) }}</strong> —
              @if (checks[check].length === 0) {
                nothing found.
              } @else {
                {{ checks[check].length }} row(s) need attention.
                <ul>
                  @for (row of checks[check]; track $index) {
                    <li style="font-size:0.85rem">{{ stringify(row) }}</li>
                  }
                </ul>
              }
            </div>
          }
        } @else {
          <p class="tas-muted">Running…</p>
        }
      </div>
    } @else if (current(); as report) {
      <div class="tas-card">
        <h2 style="margin-top:0">{{ report.label }}</h2>
        <p class="tas-muted">{{ report.blurb }}</p>

        @if (rows().length === 0) {
          <tas-empty>Nothing to report.</tas-empty>
        } @else {
          <table class="tas-table">
            <thead>
              <tr>
                @for (column of report.columns; track column.key) {
                  <th [class.tas-amount]="column.amount">{{ column.label }}</th>
                }
              </tr>
            </thead>
            <tbody>
              @for (row of rows(); track $index) {
                <tr>
                  @for (column of report.columns; track column.key) {
                    <td [class.tas-amount]="column.amount">
                      @if (column.status) {
                        <tas-status [status]="text(row[column.key])" />
                      } @else if (column.amount) {
                        {{ text(row[column.key]) | tasAmount }}
                      } @else {
                        {{ row[column.key] ?? '—' }}
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
    }
  `,
})
export class Reports implements OnInit {
  private readonly assessment = inject(AssessmentService);

  readonly rows = signal<readonly Record<string, unknown>[]>([]);
  readonly reconciliation = signal<Record<string, readonly Record<string, unknown>[]> | null>(null);
  readonly error = signal<string | null>(null);
  readonly active = signal('assessment-summary');

  jurisdiction = '';

  readonly reports: readonly ReportDefinition[] = [
    {
      id: 'assessment-summary',
      label: 'Assessment summary',
      blurb: 'Cases and net assessed by status.',
      columns: [
        { key: 'jurisdiction_code', label: 'Jurisdiction' },
        { key: 'tax_type_code', label: 'Tax' },
        { key: 'assessment_year', label: 'Year' },
        { key: 'status_code', label: 'Status', status: true },
        { key: 'case_count', label: 'Cases' },
        { key: 'net_assessed', label: 'Net assessed', amount: true },
        { key: 'currency_code', label: 'Currency' },
      ],
    },
    {
      id: 'collection',
      label: 'Collection',
      blurb:
        'Assessed against collected. Payments come from the taxpayer account, not from case status: a closed case is not necessarily a paid one.',
      columns: [
        { key: 'jurisdiction_code', label: 'Jurisdiction' },
        { key: 'tax_type_code', label: 'Tax' },
        { key: 'assessment_year', label: 'Year' },
        { key: 'case_count', label: 'Cases' },
        { key: 'net_assessed', label: 'Assessed', amount: true },
        { key: 'collected', label: 'Collected', amount: true },
        { key: 'currency_code', label: 'Currency' },
      ],
    },
    {
      id: 'adjustment-analysis',
      label: 'Adjustments',
      blurb: 'Which risk reasons earn their keep, ranked by value.',
      columns: [
        { key: 'jurisdiction_code', label: 'Jurisdiction' },
        { key: 'adjustment_type', label: 'Type' },
        { key: 'reason_code', label: 'Reason' },
        { key: 'occurrences', label: 'Count' },
        { key: 'net_effect', label: 'Net effect', amount: true },
        { key: 'average_amount', label: 'Average', amount: true },
      ],
    },
    {
      id: 'dispute-outcomes',
      label: 'Dispute outcomes',
      blurb:
        'How often the authority is overturned. A jurisdiction losing most of its objections has an assessment quality problem, not a dispute problem.',
      columns: [
        { key: 'stage', label: 'Stage' },
        { key: 'jurisdiction_code', label: 'Jurisdiction' },
        { key: 'allowed', label: 'Allowed' },
        { key: 'partly_allowed', label: 'Partly' },
        { key: 'rejected', label: 'Rejected' },
        { key: 'undecided', label: 'Undecided' },
        { key: 'out_of_time', label: 'Out of time' },
      ],
    },
    {
      id: 'ageing',
      label: 'Ageing',
      blurb: 'Where cases are stuck, and for how long.',
      columns: [
        { key: 'jurisdiction_code', label: 'Jurisdiction' },
        { key: 'status_code', label: 'Status', status: true },
        { key: 'case_count', label: 'Cases' },
        { key: 'avg_days_in_status', label: 'Average days' },
        { key: 'oldest_days', label: 'Oldest' },
        { key: 'over_90_days', label: 'Over 90 days' },
      ],
    },
    {
      id: 'deadline-exposure',
      label: 'Deadline exposure',
      blurb: 'Statutory clocks overdue or about to run out.',
      columns: [
        { key: 'jurisdiction_code', label: 'Jurisdiction' },
        { key: 'deadline_type', label: 'Deadline' },
        { key: 'status', label: 'State', status: true },
        { key: 'deadline_count', label: 'Total' },
        { key: 'overdue', label: 'Overdue' },
        { key: 'due_within_14_days', label: 'Due in 14 days' },
      ],
    },
    {
      id: 'unserved-notices',
      label: 'Unserved notices',
      blurb:
        'Issued but never successfully served. An unserved notice starts no clock, so these cases are silently frozen.',
      columns: [
        { key: 'case_number', label: 'Case' },
        { key: 'tin', label: 'TIN' },
        { key: 'notice_number', label: 'Notice' },
        { key: 'notice_type', label: 'Type' },
        { key: 'attempts', label: 'Attempts' },
        { key: 'failures', label: 'Failures' },
      ],
    },
  ];

  current(): ReportDefinition | undefined {
    return this.reports.find((report) => report.id === this.active());
  }

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async select(id: string): Promise<void> {
    this.active.set(id);
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set(null);
    try {
      if (this.active() === 'reconciliation') {
        this.reconciliation.set(await this.assessment.reconciliation());
        return;
      }
      const params = this.jurisdiction === '' ? undefined : { jurisdiction: this.jurisdiction };
      this.rows.set(await this.assessment.report(this.active(), params));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  objectKeys(value: Record<string, unknown>): string[] {
    return Object.keys(value);
  }

  label(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
  }

  text(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  stringify(value: unknown): string {
    return JSON.stringify(value);
  }
}
