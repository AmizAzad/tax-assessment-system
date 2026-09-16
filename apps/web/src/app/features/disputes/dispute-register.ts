import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AssessmentService } from '../../core/assessment.service';
import { EmptyState, ErrorAlert, StatusBadge, describeError } from '../../shared/ui';

/**
 * The dispute register.
 *
 * Plan reference: V2 section 13.7.
 *
 * ## Why objections and appeals are in one list
 *
 * The question a supervisor asks is "what is in dispute", not "what objections
 * exist". Splitting them would mean reading two screens to answer it.
 *
 * The overdue filter is the one that earns its place: an appeal decided and
 * never implemented means the taxpayer holds a judgment the register does not
 * reflect, and nothing else surfaces that.
 */
@Component({
  selector: 'tas-dispute-register',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Dispute register</h1>
        <p class="tas-muted">Objections and appeals across the whole register.</p>
      </div>
      <label class="tas-row" style="font-size:0.9rem">
        <input type="checkbox" [(ngModel)]="overdueOnly" (change)="load()" />
        Decided but not implemented
      </label>
    </div>

    <tas-error [message]="error()" />

    <div class="tas-card">
      @if (rows().length === 0) {
        <tas-empty>
          @if (overdueOnly) {
            Nothing decided is awaiting implementation. That is the answer you want here.
          } @else {
            Nothing in dispute.
          }
        </tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Reference</th>
              <th>Case</th>
              <th>TIN</th>
              <th>Filed</th>
              <th>Status</th>
              <th>Outcome</th>
              <th>In time</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track $index) {
              <tr>
                <td>{{ row['kind'] }}</td>
                <td>
                  <code>{{ row['reference'] }}</code>
                </td>
                <td>{{ row['case_number'] }}</td>
                <td class="tas-muted">{{ row['tin'] }}</td>
                <td>{{ row['filed_on'] }}</td>
                <td><tas-status [status]="asText(row['status'])" /></td>
                <td>{{ row['outcome'] ?? '—' }}</td>
                <td>
                  @if (asNumber(row['days_late']) > 0) {
                    <span style="color:var(--tas-danger)">
                      {{ row['days_late'] }} day(s) late
                    </span>
                  } @else {
                    Yes
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class DisputeRegister implements OnInit {
  private readonly assessment = inject(AssessmentService);

  readonly rows = signal<readonly Record<string, unknown>[]>([]);
  readonly error = signal<string | null>(null);

  overdueOnly = false;

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set(null);
    try {
      this.rows.set(
        await this.assessment.disputeRegister({ overdueImplementation: this.overdueOnly }),
      );
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  asText(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  asNumber(value: unknown): number {
    return typeof value === 'number' ? value : Number(value ?? 0);
  }
}
