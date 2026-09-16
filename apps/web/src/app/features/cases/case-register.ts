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
import { Router, RouterLink } from '@angular/router';
import { AssessmentService } from '../../core/assessment.service';
import { AuthService } from '../../core/auth.service';
import type { ExportJob, GridColumn, GridDefinition } from '../../core/domain';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../shared/ui';

/**
 * The assessment register.
 *
 * Plan reference: V2 sections 6.8, 9.1, 18.1 screen 3.
 *
 * ## The columns are not in this file
 *
 * They are configuration. This screen asks the server which columns to draw,
 * in what order, and how to render each one. A deployment that wants the
 * limitation date in front of every caseworker changes a row in
 * `platform.grid_definition`; nothing here is touched and nothing is released.
 *
 * ## Scoping happens on the server
 *
 * This screen sends filters and renders what comes back. It does not ask for
 * "my cases": an assessor sees their own work and an auditor sees everything
 * because the register applies the scope predicate, and a browser that decided
 * its own scope could be told otherwise by anyone with the developer tools
 * open.
 *
 * ## Why the export is a job and not a link
 *
 * A filtered register of a few thousand rows comes back ready at once. The
 * unfiltered register does not, and a download link that holds the connection
 * for a minute is one the officer cancels and retries. So the button asks for
 * an export, the screen watches it, and the file is collected when it exists.
 */
@Component({
  selector: 'tas-case-register',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, DatePipe, StatusBadge, AmountPipe, EmptyState, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Assessment register</h1>
        <p class="tas-muted">
          Scoped to what you may see. An assessor sees their own work; oversight roles see
          everything.
        </p>
      </div>
      <div class="tas-row">
        @if (canExport()) {
          <button type="button" class="tas-btn" [disabled]="exporting()" (click)="exportAs('CSV')">
            Export CSV
          </button>
          <button type="button" class="tas-btn" [disabled]="exporting()" (click)="exportAs('XLSX')">
            Export Excel
          </button>
        }
        @if (canOpen()) {
          <button type="button" class="tas-btn tas-btn--primary" (click)="showNew.set(!showNew())">
            {{ showNew() ? 'Cancel' : 'Open a case' }}
          </button>
        }
      </div>
    </div>

    <tas-error [message]="error()" />

    @if (exportJob(); as job) {
      <div class="tas-alert" role="status" aria-live="polite">
        @switch (job.status) {
          @case ('READY') {
            <span>Your {{ job.format }} export of {{ job.rowCount }} row(s) is ready.</span>
            <button type="button" class="tas-btn" (click)="collect(job)">Download</button>
          }
          @case ('FAILED') {
            <span>The export failed: {{ job.errorDetail }}</span>
          }
          @default {
            <span>
              Preparing your export. It is larger than fits in one request, so it is being built in
              the background — this page will collect it when it is ready.
            </span>
          }
        }
        <button type="button" class="tas-btn" (click)="exportJob.set(null)">Dismiss</button>
      </div>
    }

    @if (showNew()) {
      <div class="tas-card" style="margin-block-end:1rem">
        <h2>Open an assessment case</h2>
        <p class="tas-muted">
          One live case per taxpayer, tax type and year. The currency comes from the rule set in
          force, not from this form.
        </p>
        <div class="tas-grid">
          <div class="tas-field">
            <label for="new-taxpayer">Taxpayer id</label>
            <input id="new-taxpayer" type="number" [(ngModel)]="newTaxpayerId" />
          </div>
          <div class="tas-field">
            <label for="new-taxtype">Tax type</label>
            <input id="new-taxtype" [(ngModel)]="newTaxType" />
          </div>
          <div class="tas-field">
            <label for="new-year">Assessment year</label>
            <input id="new-year" [(ngModel)]="newYear" />
          </div>
          <div class="tas-field">
            <label for="new-type">Assessment type</label>
            <select id="new-type" [(ngModel)]="newAssessmentType">
              <option value="DESK">Desk</option>
              <option value="FIELD">Field</option>
              <option value="BEST_JUDGEMENT">Best judgement</option>
            </select>
          </div>
          <div class="tas-field">
            <label for="new-trigger">Why</label>
            <select id="new-trigger" [(ngModel)]="newTrigger">
              <option value="RISK">Risk</option>
              <option value="RANDOM">Random</option>
              <option value="NON_FILER">Non-filer</option>
              <option value="THIRD_PARTY">Third-party data</option>
              <option value="REFERRAL">Referral</option>
            </select>
          </div>
        </div>
        <div class="tas-row" style="margin-block-start:1rem">
          <button
            type="button"
            class="tas-btn tas-btn--primary"
            [disabled]="busy()"
            (click)="open()"
          >
            Open case
          </button>
        </div>
      </div>
    }

    <div class="tas-card">
      <div class="tas-row" style="margin-block-end:1rem">
        <div class="tas-field">
          <label for="f-search">Search</label>
          <input
            id="f-search"
            [(ngModel)]="filterSearch"
            (keyup.enter)="goto(1)"
            placeholder="Case number, taxpayer or TIN"
          />
        </div>
        <div class="tas-field">
          <label for="f-status">Status</label>
          <select id="f-status" [(ngModel)]="filterStatus" (change)="goto(1)">
            <option value="">Any</option>
            @for (status of statuses; track status) {
              <option [value]="status">{{ status }}</option>
            }
          </select>
        </div>
        <div class="tas-field">
          <label for="f-taxtype">Tax type</label>
          <input id="f-taxtype" [(ngModel)]="filterTaxType" (change)="goto(1)" placeholder="CIT" />
        </div>
        <div class="tas-field">
          <label for="f-size">Per page</label>
          <select id="f-size" [(ngModel)]="pageSize" (change)="goto(1)">
            <option [value]="25">25</option>
            <option [value]="50">50</option>
            <option [value]="100">100</option>
          </select>
        </div>
      </div>

      @if (loading()) {
        <p class="tas-muted">Loading…</p>
      } @else if (rows().length === 0) {
        <tas-empty>
          No cases match. Cases are opened from the register or by a risk selection run.
        </tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              @for (column of visibleColumns(); track column.key) {
                <th
                  [style.text-align]="column.align === 'end' ? 'end' : null"
                  [attr.aria-sort]="ariaSort(column)"
                >
                  @if (column.sortable) {
                    <button type="button" class="tas-sort" (click)="sortBy(column.key)">
                      {{ column.label }}<span aria-hidden="true">{{ sortMark(column.key) }}</span>
                    </button>
                  } @else {
                    {{ column.label }}
                  }
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row['id']) {
              <tr>
                @for (column of visibleColumns(); track column.key) {
                  <td
                    [class.tas-amount]="column.type === 'amount'"
                    [style.text-align]="column.align === 'end' ? 'end' : null"
                  >
                    @switch (column.type) {
                      @case ('link') {
                        <a [routerLink]="['/cases', row['id']]">{{ text(row, column) }}</a>
                      }
                      @case ('status') {
                        <tas-status [status]="text(row, column)" />
                      }
                      @case ('amount') {
                        {{ text(row, column) | tasAmount }}
                      }
                      @case ('date') {
                        <span class="tas-muted">{{
                          dateOf(row, column) | date: 'yyyy-MM-dd'
                        }}</span>
                      }
                      @case ('datetime') {
                        <span class="tas-muted">{{
                          dateOf(row, column) | date: 'yyyy-MM-dd HH:mm'
                        }}</span>
                      }
                      @case ('taxpayer') {
                        {{ text(row, column) }}
                        <div class="tas-muted" style="font-size:0.8rem">{{ row['tin'] }}</div>
                      }
                      @default {
                        {{ text(row, column) }}
                      }
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>

        <div class="tas-row" style="margin-block-start:1rem; justify-content:space-between">
          <span class="tas-muted">{{ total() }} case(s)</span>
          <span class="tas-row">
            <button
              type="button"
              class="tas-btn"
              [disabled]="page() <= 1"
              (click)="goto(page() - 1)"
            >
              Previous
            </button>
            <span class="tas-muted">Page {{ page() }}</span>
            <button
              type="button"
              class="tas-btn"
              [disabled]="page() * Number(pageSize) >= total()"
              (click)="goto(page() + 1)"
            >
              Next
            </button>
          </span>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .tas-sort {
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        font-weight: inherit;
        color: inherit;
        cursor: pointer;
      }
      .tas-sort:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class CaseRegister implements OnInit {
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** So the template can compare a string-bound select to a number. */
  protected readonly Number = Number;

  readonly definition = signal<GridDefinition | null>(null);
  readonly rows = signal<readonly Record<string, unknown>[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly sort = signal<string | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly exporting = signal(false);
  readonly exportJob = signal<ExportJob | null>(null);
  readonly error = signal<string | null>(null);
  readonly showNew = signal(false);

  readonly visibleColumns = computed(() =>
    (this.definition()?.columns ?? []).filter((column) => column.exportOnly !== true),
  );

  pageSize = 25;
  filterStatus = '';
  filterTaxType = '';
  filterSearch = '';

  newTaxpayerId = 1;
  newTaxType = 'CIT';
  newYear = '2024';
  newAssessmentType = 'DESK';
  newTrigger = 'RISK';

  /** The statuses worth filtering on, in lifecycle order rather than alphabetical. */
  readonly statuses = [
    'INITIATED',
    'DATA_READY',
    'ASSIGNED',
    'IN_PREPARATION',
    'CALCULATED',
    'UNDER_REVIEW',
    'REVIEWED',
    'PENDING_APPROVAL',
    'APPROVED',
    'FINALISED',
    'NOTICE_SERVED',
    'AWAITING_TAXPAYER_RESPONSE',
    'UNDER_OBJECTION',
    'UNDER_APPEAL',
    'SETTLED',
    'CLOSED',
  ];

  canOpen(): boolean {
    return this.auth.canInvoke('POST', '/api/v1/cases');
  }

  canExport(): boolean {
    return this.auth.canInvoke('POST', '/api/v1/exports');
  }

  async ngOnInit(): Promise<void> {
    try {
      const definition = await this.assessment.gridDefinition('ASSESSMENT_REGISTER');
      this.definition.set(definition);
      this.sort.set(definition.defaultSort);
    } catch (error) {
      // A register with no configuration is a deployment fault, and the
      // screen should say so rather than render an empty table.
      this.error.set(describeError(error));
    }
    await this.load();
  }

  /** A cell's value as text. Never parsed, never rounded. */
  text(row: Record<string, unknown>, column: GridColumn): string {
    const value = row[column.key];
    return value === null || value === undefined ? '' : String(value);
  }

  /**
   * A cell's value as something the date pipe accepts.
   *
   * The rows are `Record<string, unknown>` because the columns are
   * configuration, so every value arrives untyped and has to be narrowed at
   * the point of use rather than trusted.
   */
  dateOf(row: Record<string, unknown>, column: GridColumn): string | null {
    const value = row[column.key];
    return typeof value === 'string' && value !== '' ? value : null;
  }

  ariaSort(column: GridColumn): string | null {
    const sort = this.sort();
    if (sort === null || !sort.startsWith(`${column.key}:`)) {
      return column.sortable ? 'none' : null;
    }
    return sort.endsWith(':desc') ? 'descending' : 'ascending';
  }

  sortMark(key: string): string {
    const sort = this.sort();
    if (sort === null || !sort.startsWith(`${key}:`)) {
      return '';
    }
    return sort.endsWith(':desc') ? ' ↓' : ' ↑';
  }

  async sortBy(key: string): Promise<void> {
    const current = this.sort();
    const ascending = current === `${key}:asc`;
    this.sort.set(`${key}:${ascending ? 'desc' : 'asc'}`);
    await this.goto(1);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const result = await this.assessment.register({
        ...this.filters(),
        sort: this.sort() ?? undefined,
        page: this.page(),
        pageSize: Number(this.pageSize),
      });
      this.rows.set(result.rows);
      this.total.set(result.total);
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.loading.set(false);
    }
  }

  async goto(page: number): Promise<void> {
    this.page.set(Math.max(1, page));
    await this.load();
  }

  /**
   * Ask for an export of exactly what is on screen.
   *
   * The same filters, so the file matches the register the officer is looking
   * at. If it comes back queued, the screen polls: a large export is built by
   * the worker and there is nothing to download yet.
   */
  async exportAs(format: 'CSV' | 'XLSX'): Promise<void> {
    this.exporting.set(true);
    this.error.set(null);
    try {
      let job = await this.assessment.requestExport(
        'ASSESSMENT_REGISTER',
        format,
        this.filters(),
        this.sort() ?? undefined,
      );
      this.exportJob.set(job);

      // Up to five minutes, then stop asking and leave the job on screen: the
      // officer can come back to it, and an indefinite poll would keep a tab
      // talking to the API all afternoon.
      for (
        let attempt = 0;
        attempt < 60 && job.status !== 'READY' && job.status !== 'FAILED';
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        job = await this.assessment.exportStatus(job.uuid);
        this.exportJob.set(job);
      }
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.exporting.set(false);
    }
  }

  /** Collect a finished export and hand it to the browser. */
  async collect(job: ExportJob): Promise<void> {
    try {
      const file = await this.assessment.downloadExport(job.uuid);
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  async open(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const created = await this.assessment.createCase({
        taxpayerId: Number(this.newTaxpayerId),
        taxTypeCode: this.newTaxType,
        assessmentYear: this.newYear,
        assessmentType: this.newAssessmentType,
        triggerPath: this.newTrigger,
      });
      // Straight into the workbench: the next thing anybody does with a new
      // case is retrieve its evidence.
      await this.router.navigate(['/cases', created.id]);
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  private filters(): Record<string, string> {
    const filters: Record<string, string> = {};
    if (this.filterStatus) filters['status'] = this.filterStatus;
    if (this.filterTaxType) filters['taxTypeCode'] = this.filterTaxType;
    if (this.filterSearch) filters['search'] = this.filterSearch;
    return filters;
  }
}
