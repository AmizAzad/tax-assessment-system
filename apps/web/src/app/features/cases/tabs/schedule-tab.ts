import { ChangeDetectionStrategy, Component, Input, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AssessmentService } from '../../../core/assessment.service';
import type { RecordedDeadline, SlaClock } from '../../../core/domain';
import { EmptyState, ErrorAlert, StatusBadge, describeError } from '../../../shared/ui';

/**
 * Statutory deadlines and internal service clocks, side by side but apart.
 *
 * Plan reference: V2 sections 10.4, 10.5.
 *
 * ## Why two panels and not one table
 *
 * A deadline binds the taxpayer; an SLA is a target the authority set itself.
 * Showing them in one list would invite the reading that a missed service
 * standard is a legal event, or that a statutory date is negotiable. They are
 * separated here for the same reason they are separate tables.
 *
 * Each deadline shows how it was derived, because that sentence is what ends
 * up quoted on a penalty notice and later challenged.
 */
@Component({
  selector: 'tas-case-schedule',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <h2 style="margin-top:0">Statutory deadlines</h2>
      <p class="tas-muted">
        Dates the taxpayer is bound by. Each runs from a recorded anchor event, on the
        jurisdiction's own working calendar.
      </p>
      @if (deadlines().length === 0) {
        <tas-empty>
          None running. Deadlines are materialised by the events that start them, such as a notice
          being served.
        </tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Deadline</th>
              <th>Anchored on</th>
              <th>Due</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            @for (d of deadlines(); track d.deadline_type + d.anchor_event) {
              <tr>
                <td>{{ d.deadline_type }}</td>
                <td class="tas-muted">
                  {{ d.anchor_event }} {{ d.anchor_at | date: 'yyyy-MM-dd' }}
                </td>
                <td>{{ d.due_at | date: 'yyyy-MM-dd' }}</td>
                <td><tas-status [status]="d.status" /></td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Service clocks</h2>
      <p class="tas-muted">
        Internal targets. A missed service standard is never a time bar, which is why these are
        recorded apart from the deadlines above.
      </p>
      @if (clocks().length === 0) {
        <tas-empty>No clocks running. One starts when the case enters a measured stage.</tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Standard</th>
              <th>Stage</th>
              <th>Started</th>
              <th>Target</th>
              <th>State</th>
              <th style="width:10rem">Remaining</th>
            </tr>
          </thead>
          <tbody>
            @for (clock of clocks(); track clock.slaCode) {
              <tr>
                <td>{{ clock.slaCode }}</td>
                <td class="tas-muted">{{ clock.stageCode ?? '—' }}</td>
                <td>{{ clock.startedAt | date: 'yyyy-MM-dd' }}</td>
                <td>{{ clock.targetAt | date: 'yyyy-MM-dd' }}</td>
                <td><tas-status [status]="clock.status" /></td>
                <td>
                  @if (clock.daysRemaining !== null) {
                    <span>{{ clock.daysRemaining }} day(s)</span>
                    <div
                      class="tas-bar"
                      [class.tas-bar--warn]="clock.daysRemaining <= 3 && clock.daysRemaining >= 0"
                      [class.tas-bar--over]="clock.daysRemaining < 0"
                    >
                      <span [style.width.%]="barWidth(clock.daysRemaining)"></span>
                    </div>
                  } @else {
                    <span class="tas-muted">—</span>
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
export class CaseSchedule implements OnInit {
  private readonly assessment = inject(AssessmentService);

  @Input({ required: true }) caseId!: number;

  readonly deadlines = signal<readonly RecordedDeadline[]>([]);
  readonly clocks = signal<readonly SlaClock[]>([]);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.deadlines.set(await this.assessment.recordedDeadlines(this.caseId));
      this.clocks.set(await this.assessment.slaClocks(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  /**
   * A rough fullness for the progress bar.
   *
   * Presentation only, and deliberately capped: this is a visual cue about
   * time left, not a figure anybody should read off the screen.
   */
  barWidth(daysRemaining: number): number {
    if (daysRemaining <= 0) return 100;
    return Math.max(5, Math.min(100, 100 - daysRemaining * 4));
  }
}
