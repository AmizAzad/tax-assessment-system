import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';
import { AssessmentService } from '../../core/assessment.service';
import { AuthService } from '../../core/auth.service';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../shared/ui';

/**
 * Administration.
 *
 * Plan reference: V2 sections 6.3, 21.4.
 *
 * ## What this screen is for
 *
 * Seeing what a deployment actually holds: which routes are registered, what
 * each role may do, the delegation limits, and the scheduled jobs. The
 * authorisation catalogue is route-keyed and fails closed, so an unregistered
 * route is refused to everybody — which makes "is this route in the catalogue"
 * the first question when something returns 403 that should not.
 *
 * ## Why the permission cache has a visible refresh
 *
 * Grants are cached in Redis. A grant changed directly in the database is not
 * live until the cache turns over, and an administrator who has just fixed a
 * permission needs a way to make it take effect that does not involve
 * restarting the API.
 */
@Component({
  selector: 'tas-admin',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Administration</h1>
        <p class="tas-muted">
          What this deployment holds: routes, grants, delegation limits and jobs.
        </p>
      </div>
      <button type="button" class="tas-btn" [disabled]="busy()" (click)="refreshCache()">
        Refresh permission cache
      </button>
    </div>

    <tas-error [message]="error()" />
    @if (note(); as message) {
      <div class="tas-alert">{{ message }}</div>
    }

    <nav class="tas-tabs" role="tablist">
      @for (tab of tabs; track tab.id) {
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="active() === tab.id"
          (click)="select(tab.id)"
        >
          {{ tab.label }}
        </button>
      }
    </nav>

    @switch (active()) {
      @case ('permissions') {
        <div class="tas-card">
          <h2 style="margin-top:0">Permission catalogue</h2>
          <p class="tas-muted">
            Route-keyed and fail-closed: a route absent from this list is refused to everybody,
            whatever role they hold.
          </p>
          <div class="tas-field" style="max-width:24rem">
            <label for="perm-filter">Filter</label>
            <input id="perm-filter" [(ngModel)]="filter" placeholder="cases, notices, reports…" />
          </div>
          @if (filteredPermissions().length === 0) {
            <tas-empty>Nothing matches.</tas-empty>
          } @else {
            <p class="tas-muted">{{ filteredPermissions().length }} registered route(s).</p>
            <ul style="columns:2; font-size:0.85rem; margin:0">
              @for (route of filteredPermissions(); track route) {
                <li>
                  <code>{{ route }}</code>
                </li>
              }
            </ul>
          }
        </div>
      }
      @case ('thresholds') {
        <div class="tas-card">
          <h2 style="margin-top:0">Approval delegation limits</h2>
          <p class="tas-muted">
            Which approver an assessment needs, by amount. The band is chosen from these rows and
            never by the caller.
          </p>
          @if (thresholds().length === 0) {
            <tas-empty>No limits configured.</tas-empty>
          } @else {
            <table class="tas-table">
              <thead>
                <tr>
                  <th>Jurisdiction</th>
                  <th>Tax</th>
                  <th style="text-align:end">From</th>
                  <th style="text-align:end">To</th>
                  <th>Currency</th>
                  <th>Approver</th>
                  <th>Approvals</th>
                </tr>
              </thead>
              <tbody>
                @for (row of thresholds(); track $index) {
                  <tr>
                    <td>{{ row['jurisdiction_code'] }}</td>
                    <td>{{ row['tax_type_code'] }}</td>
                    <td class="tas-amount">{{ text(row['amount_from']) | tasAmount }}</td>
                    <td class="tas-amount">
                      {{ row['amount_to'] ? (text(row['amount_to']) | tasAmount) : 'no ceiling' }}
                    </td>
                    <td>{{ row['currency_code'] }}</td>
                    <td>
                      <code>{{ row['required_role_code'] }}</code>
                    </td>
                    <td>{{ row['required_approvals'] }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      }
      @case ('jobs') {
        <div class="tas-card">
          <h2 style="margin-top:0">Scheduled jobs</h2>
          <p class="tas-muted">
            Deadline sweeps, auto-closure and notification dispatch. Jobs hold a cross-replica lock,
            so only one instance runs each.
          </p>
          @if (jobs().length === 0) {
            <tas-empty>No jobs registered.</tas-empty>
          } @else {
            <table class="tas-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Schedule</th>
                  <th>Last run</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                @for (job of jobs(); track $index) {
                  <tr>
                    <td>
                      <code>{{ job['jobCode'] }}</code>
                    </td>
                    <td class="tas-muted">{{ job['cronExpression'] }}</td>
                    <td class="tas-muted">{{ job['lastRunAt'] ?? '—' }}</td>
                    <td><tas-status [status]="text(job['lastStatus'] ?? 'IDLE')" /></td>
                    <td class="tas-muted" style="font-size:0.8rem">{{ job['lastError'] ?? '' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
        </div>
      }
      @case ('me') {
        <div class="tas-card">
          <h2 style="margin-top:0">Who I am</h2>
          <p class="tas-muted">
            The identity and effective permissions this browser is acting with. Useful when a screen
            is missing: the navigation is filtered by exactly this list.
          </p>
          @if (caller(); as me) {
            <dl class="tas-facts">
              <div>
                <dt>Username</dt>
                <dd>{{ me.username ?? '—' }}</dd>
              </div>
              <div>
                <dt>User id</dt>
                <dd>{{ me.userId ?? '—' }}</dd>
              </div>
              <div>
                <dt>Jurisdiction</dt>
                <dd>{{ me.jurisdictionCode }}</dd>
              </div>
              <div>
                <dt>Roles</dt>
                <dd>{{ me.roleCodes.join(', ') }}</dd>
              </div>
            </dl>
            <h3>Effective permissions</h3>
            <ul style="columns:2; font-size:0.85rem">
              @for (permission of me.permissions; track permission) {
                <li>
                  <code>{{ permission }}</code>
                </li>
              }
            </ul>
          }
        </div>
      }
    }
  `,
})
export class Admin implements OnInit {
  private readonly api = inject(ApiService);
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);

  readonly permissions = signal<readonly string[]>([]);
  readonly thresholds = signal<readonly Record<string, unknown>[]>([]);
  readonly jobs = signal<readonly Record<string, unknown>[]>([]);
  readonly error = signal<string | null>(null);
  readonly note = signal<string | null>(null);
  readonly busy = signal(false);
  readonly active = signal('permissions');

  readonly caller = this.auth.caller;

  filter = '';

  readonly tabs = [
    { id: 'permissions', label: 'Permissions' },
    { id: 'thresholds', label: 'Delegation limits' },
    { id: 'jobs', label: 'Scheduled jobs' },
    { id: 'me', label: 'My access' },
  ];

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
      if (this.active() === 'permissions' && this.permissions().length === 0) {
        // The endpoint returns `{ routes: string[] }`, not rows: the catalogue
        // is route-keyed, and the route is the whole key.
        const catalogue = await this.api.get<{ routes: readonly string[] }>('/admin/permissions');
        this.permissions.set(catalogue.routes ?? []);
      }
      if (this.active() === 'thresholds' && this.thresholds().length === 0) {
        this.thresholds.set(await this.assessment.approvalThresholds());
      }
      if (this.active() === 'jobs' && this.jobs().length === 0) {
        this.jobs.set(await this.api.get('/admin/jobs'));
      }
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  filteredPermissions(): readonly string[] {
    const needle = this.filter.trim().toLowerCase();
    if (needle === '') return this.permissions();
    return this.permissions().filter((route) => route.toLowerCase().includes(needle));
  }

  async refreshCache(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.note.set(null);
    try {
      await this.api.post('/admin/permissions/refresh-cache');
      this.note.set('Permission cache cleared. Grants changed in the database are now live.');
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  text(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }
}
