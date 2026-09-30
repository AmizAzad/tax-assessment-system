import { Component, ChangeDetectionStrategy, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { StatusBadge } from '../../shared/ui';

interface JobStatus {
  readonly jobCode: string;
  readonly cronExpression: string;
  readonly enabled: boolean;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
}

/**
 * Landing screen.
 *
 * Shows the caller's effective permissions, because during Phase 1 the most
 * useful thing this app can tell you is what the authorisation model actually
 * decided — which is otherwise only visible in a database table.
 */
@Component({
  selector: 'tas-home',
  standalone: true,
  imports: [DatePipe, StatusBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Welcome{{ caller()?.username ? ', ' + caller()!.username : '' }}</h1>

    <div class="tas-card">
      <h2>Your access</h2>
      @if (caller(); as user) {
        <p>
          Roles: <strong>{{ user.roleCodes.join(', ') || 'none' }}</strong
          ><br />
          Jurisdiction: <strong>{{ user.jurisdictionCode }}</strong>
        </p>
        <h3>Routes you may invoke ({{ user.permissions.length }})</h3>
        <ul class="tas-permissions">
          @for (permission of user.permissions; track permission) {
            <li>
              <code>{{ permission }}</code>
            </li>
          }
        </ul>
        <p class="tas-muted">
          This list is what the server granted. The UI uses it to hide what you cannot use — the API
          enforces it regardless.
        </p>
      } @else {
        <p class="tas-muted">Not signed in.</p>
      }
    </div>

    @if (jobs().length > 0) {
      <div class="tas-card" style="margin-top:1.25rem">
        <h2>Scheduled jobs</h2>
        <table class="tas-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Schedule</th>
              <th>Last run</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            @for (job of jobs(); track job.jobCode) {
              <tr>
                <td>
                  <code>{{ job.jobCode }}</code>
                </td>
                <td>{{ job.cronExpression }}</td>
                <td>
                  @if (job.lastRunAt) {
                    {{ job.lastRunAt | date: 'yyyy-MM-dd HH:mm' }}
                  } @else {
                    <span class="tas-muted">never</span>
                  }
                </td>
                <td>
                  @if (job.lastStatus) {
                    <tas-status [status]="job.lastStatus" />
                  } @else {
                    —
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: [
    `
      /* Two columns only where two route keys fit side by side; on a phone
         one column, and a long key wraps rather than running off the page. */
      .tas-permissions {
        columns: 2 22rem;
        font-size: 0.85rem;
        margin: 0.5rem 0;
        padding-inline-start: 1.1rem;
      }
      .tas-permissions code {
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class Home implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  readonly caller = this.auth.caller;
  readonly jobs = signal<readonly JobStatus[]>([]);

  async ngOnInit(): Promise<void> {
    // Administrators only. A 403 here is expected for everyone else and is not
    // worth surfacing as an error.
    if (!this.auth.canInvoke('GET', '/api/v1/admin/jobs')) {
      return;
    }
    try {
      this.jobs.set(await this.api.get<JobStatus[]>('/admin/jobs'));
    } catch {
      this.jobs.set([]);
    }
  }
}
