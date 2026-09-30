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
  // The movement stays on one line: two badges stacked with the arrow
  // floating beside the first read as two events rather than one change.
  styles: `
    .tas-movement {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      white-space: nowrap;
    }
    /* A timestamp broken over three lines is read as three values. */
    .tas-when {
      white-space: nowrap;
    }
    /* Payload values include 64-character hashes, which otherwise push the
       row past the card instead of wrapping inside the column. */
    .tas-detail {
      overflow-wrap: anywhere;
      min-width: 16rem;
    }
  `,
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
              <th>When</th>
              <th>Event</th>
              <th>Movement</th>
              <th>Who</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of entries(); track $index) {
              <tr>
                <td class="tas-muted tas-when">
                  {{ entry.occurredAt | date: 'yyyy-MM-dd HH:mm' }}
                </td>
                <td>
                  <code>{{ entry.eventType }}</code>
                </td>
                <td>
                  <span class="tas-movement">
                    @if (entry.fromStatus && entry.toStatus) {
                      <tas-status [status]="entry.fromStatus" />
                      <span class="tas-muted" aria-label="to">→</span>
                      <tas-status [status]="entry.toStatus" />
                    } @else if (entry.toStatus ?? entry.fromStatus; as only) {
                      <!-- A step recorded without moving the case: its status, no arrow. -->
                      <tas-status [status]="only" />
                    }
                  </span>
                </td>
                <td>
                  @if (entry.actorUsername || entry.actorRoleCode) {
                    {{ entry.actorUsername ?? 'unknown' }}
                    @if (entry.actorRoleCode) {
                      <div class="tas-muted" style="font-size:0.75rem">
                        {{ entry.actorRoleCode }}
                      </div>
                    }
                  } @else {
                    <span class="tas-muted">system</span>
                  }
                </td>
                <td class="tas-muted tas-detail" style="font-size:0.8rem">{{ describe(entry) }}</td>
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
