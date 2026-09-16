import { ChangeDetectionStrategy, Component, Input, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AssessmentService } from '../../../core/assessment.service';
import type { TimelineEntry } from '../../../core/domain';
import { EmptyState, ErrorAlert, StatusBadge, describeError } from '../../../shared/ui';

/**
 * The case ledger.
 *
 * Plan reference: V2 sections 9.5, 20.
 *
 * ## Why this is the tab an auditor opens first
 *
 * Every status change is written with its event in the same transaction as the
 * change itself, so this list is not a log that might have missed something:
 * it is the record. If a case moved, there is a row here, and if there is no
 * row the case did not move.
 *
 * Newest first, because the question is almost always "what just happened".
 */
@Component({
  selector: 'tas-case-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <h2 style="margin-top:0">History</h2>
      <p class="tas-muted">
        Every movement, written with the status change it accompanies. This is the record, not a log
        alongside one.
      </p>

      @if (entries().length === 0) {
        <tas-empty>Nothing recorded yet.</tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th style="width:12rem">When</th>
              <th>Event</th>
              <th>Movement</th>
              <th>Who</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of entries(); track $index) {
              <tr>
                <td class="tas-muted">{{ entry.occurredAt | date: 'yyyy-MM-dd HH:mm' }}</td>
                <td>
                  <code>{{ entry.eventType }}</code>
                </td>
                <td>
                  @if (entry.fromStatus) {
                    <tas-status [status]="entry.fromStatus" />
                    <span class="tas-muted">→</span>
                  }
                  @if (entry.toStatus) {
                    <tas-status [status]="entry.toStatus" />
                  }
                </td>
                <td>{{ entry.actor ?? 'system' }}</td>
                <td class="tas-muted" style="font-size:0.8rem">{{ describe(entry) }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class CaseTimeline implements OnInit {
  private readonly assessment = inject(AssessmentService);

  @Input({ required: true }) caseId!: number;

  readonly entries = signal<readonly TimelineEntry[]>([]);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.entries.set(await this.assessment.timeline(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  /**
   * A one-line summary of the event payload.
   *
   * The payload differs per action, so rendering it generically is the honest
   * option: inventing a sentence per event type would mean an event nobody
   * wrote a sentence for shows as blank.
   */
  describe(entry: TimelineEntry): string {
    const payload = entry.payload;
    if (payload === undefined || payload === null) return '';
    return Object.entries(payload)
      .filter(([key]) => key !== 'action')
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join(' · ');
  }
}
