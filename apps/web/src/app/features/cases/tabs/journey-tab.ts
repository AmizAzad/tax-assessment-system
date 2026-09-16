import { ChangeDetectionStrategy, Component, Input, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AssessmentService } from '../../../core/assessment.service';
import type { ProcessJourney } from '../../../core/domain';
import { BpmnDiagram } from '../../../shared/bpmn-diagram';
import { EmptyState, ErrorAlert, HumanisePipe, describeError } from '../../../shared/ui';

/**
 * Where the case has reached in its process.
 *
 * Plan reference: V2 section 18.1 screen 14, section 5.4.
 *
 * ## Why a case with no process is a normal answer
 *
 * Orchestration never fails a case. A case opened while the engine was
 * unreachable has no process instance and is worked perfectly well by hand, so
 * this tab says exactly that rather than showing an error or an empty diagram.
 * Treating it as a fault would send officers chasing a problem that is not
 * one.
 *
 * ## Why the step list is underneath the diagram
 *
 * The diagram is the illustration; the event list is the fact. If the diagram
 * cannot be drawn — an old definition, a browser that dislikes the SVG — the
 * list still answers the question.
 */
@Component({
  selector: 'tas-case-journey',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, BpmnDiagram, EmptyState, ErrorAlert, HumanisePipe],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <h2 style="margin-top:0">Process journey</h2>

      @if (loading()) {
        <p class="tas-muted">Loading…</p>
      } @else if (journey(); as j) {
        @if (!j.coordinated) {
          <tas-empty>
            No process is coordinating this case. That is not a fault: a case opened while the
            engine was unavailable is worked by hand, and every action on it is recorded the same
            way. The reconciliation report lists cases in this position.
          </tas-empty>
        } @else {
          <p class="tas-muted">
            Definition <code>{{ j.workflowCode }}</code
            >, instance <code>{{ j.processInstanceId }}</code
            >. Green has finished; amber is waiting on somebody now.
          </p>

          <tas-bpmn-diagram
            [bpmnXml]="j.bpmnXml"
            [completed]="j.completed"
            [active]="j.active"
            [height]="440"
          />

          @if (j.active.length > 0) {
            <p style="margin-block-start:0.75rem">
              <strong>Currently at:</strong>
              {{ activeNames(j) }}
            </p>
          }

          <h3>Steps</h3>
          @if (j.history.length === 0) {
            <tas-empty>The engine has not reported any step yet.</tas-empty>
          } @else {
            <table class="tas-table">
              <thead>
                <tr>
                  <th style="width:12rem">When</th>
                  <th>Step</th>
                  <th>Kind</th>
                  <th>Event</th>
                </tr>
              </thead>
              <tbody>
                @for (entry of j.history; track $index) {
                  <tr>
                    <td class="tas-muted">{{ entry.occurredAt | date: 'yyyy-MM-dd HH:mm:ss' }}</td>
                    <td>{{ entry.activityName ?? entry.activityId ?? '—' }}</td>
                    <td class="tas-muted">{{ entry.activityType ?? '—' }}</td>
                    <td>{{ entry.eventType | tasHumanise }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        }
      }
    </div>
  `,
})
export class CaseJourney implements OnInit {
  private readonly assessment = inject(AssessmentService);

  @Input({ required: true }) caseId!: number;

  readonly journey = signal<ProcessJourney | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      this.journey.set(await this.assessment.journey(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** The names of the steps currently waiting, read from the reported history. */
  activeNames(journey: ProcessJourney): string {
    const names = journey.active.map((activityId) => {
      const entry = journey.history.find((row) => row.activityId === activityId);
      return entry?.activityName ?? activityId;
    });
    return names.join(', ');
  }
}
