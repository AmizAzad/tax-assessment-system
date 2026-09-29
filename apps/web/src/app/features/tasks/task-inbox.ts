import { Component, ChangeDetectionStrategy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';

interface InboxTask {
  readonly taskId: string;
  readonly businessKey?: string;
  readonly stepCode?: string;
  readonly name?: string;
  readonly assignee?: string;
  readonly dueAt?: string;
  readonly roleCodes: readonly string[];
  readonly overdue: boolean;
}

/**
 * The officer's task inbox.
 *
 * Served from the workflow read model, not the engine (plan 5.4): an
 * interactive screen should not depend on a second service's availability.
 *
 * It is empty whenever no process instance is waiting on one of the caller's
 * roles, which includes every case worked by hand while the engine is down.
 * That is the correct state, not a failure, and the empty message says so.
 */
@Component({
  selector: 'tas-task-inbox',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>My tasks</h1>

    @if (error(); as message) {
      <div class="tas-alert tas-alert--danger" role="alert">{{ message }}</div>
    } @else if (tasks().length === 0) {
      <div class="tas-card">
        <p class="tas-muted">No open tasks.</p>
        <p class="tas-muted">
          Tasks appear here when the process engine assigns a step to one of your roles. Cases being
          worked by hand are in <a routerLink="/queues">My Queues</a>.
        </p>
      </div>
    } @else {
      <table class="tas-table">
        <thead>
          <tr>
            <th>Case</th>
            <th>Step</th>
            <th>Task</th>
            <th>Assignee</th>
            <th>Due</th>
          </tr>
        </thead>
        <tbody>
          @for (task of tasks(); track task.taskId) {
            <tr [class.is-overdue]="task.overdue">
              <td>
                <code>{{ task.businessKey ?? '—' }}</code>
              </td>
              <td>{{ task.stepCode ?? '—' }}</td>
              <td>{{ task.name ?? '—' }}</td>
              <td>{{ task.assignee ?? 'unclaimed' }}</td>
              <td>{{ task.dueAt ?? '—' }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: [
    `
      .is-overdue {
        background: var(--tas-danger-bg);
      }
    `,
  ],
})
export class TaskInbox implements OnInit {
  private readonly api = inject(ApiService);

  readonly tasks = signal<readonly InboxTask[]>([]);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.tasks.set(await this.api.get<InboxTask[]>('/workflow/tasks'));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not load tasks');
    }
  }
}
