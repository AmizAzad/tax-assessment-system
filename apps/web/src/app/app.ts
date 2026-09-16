import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth.service';
import { I18nService } from './core/i18n.service';

interface NavItem {
  readonly path: string;
  readonly label: string;
  /** The API route this screen needs. Hidden when the caller cannot invoke it. */
  readonly requires?: { method: string; path: string };
}

/**
 * The application shell.
 *
 * Plan reference: V2 sections 18.1, 18.3.
 *
 * Navigation is filtered by the caller's effective permissions, so an officer
 * is not shown a screen that will 403. That is a courtesy, not a control — the
 * API decides.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App implements OnInit {
  private readonly auth = inject(AuthService);
  readonly i18n = inject(I18nService);

  readonly ready = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly caller = this.auth.caller;
  readonly isAuthenticated = this.auth.isAuthenticated;

  private readonly allNav: readonly NavItem[] = [
    { path: '', label: 'Home' },
    {
      path: 'dashboard',
      label: 'Dashboard',
      requires: { method: 'GET', path: '/api/v1/dashboard/summary' },
    },
    {
      path: 'portal',
      label: 'My Tax Affairs',
      requires: { method: 'GET', path: '/api/v1/portal/cases' },
    },
    {
      path: 'cases',
      label: 'Cases',
      requires: { method: 'GET', path: '/api/v1/cases' },
    },
    {
      path: 'queues',
      label: 'My Queues',
      requires: { method: 'GET', path: '/api/v1/cases' },
    },
    {
      path: 'disputes',
      label: 'Disputes',
      requires: { method: 'GET', path: '/api/v1/disputes' },
    },
    {
      path: 'selection',
      label: 'Selection',
      requires: { method: 'GET', path: '/api/v1/selection/runs' },
    },
    {
      path: 'rules',
      label: 'Rule Sets',
      requires: { method: 'GET', path: '/api/v1/rule-sets' },
    },
    {
      path: 'reports',
      label: 'Reports',
      requires: { method: 'GET', path: '/api/v1/reports/assessment-summary' },
    },
    {
      path: 'tasks',
      label: 'My Tasks',
      requires: { method: 'GET', path: '/api/v1/workflow/tasks' },
    },
    {
      path: 'masters',
      label: 'Reference Data',
      requires: { method: 'GET', path: '/api/v1/masters/:groupCode' },
    },
    {
      path: 'forms',
      label: 'Forms',
      requires: { method: 'GET', path: '/api/v1/forms/templates' },
    },
    {
      path: 'forms/builder',
      label: 'Form Builder',
      requires: { method: 'GET', path: '/api/v1/forms/templates' },
    },
    {
      path: 'processes',
      label: 'Process Modeller',
      requires: { method: 'POST', path: '/api/v1/processes/deploy' },
    },
    {
      path: 'admin',
      label: 'Administration',
      requires: { method: 'GET', path: '/api/v1/admin/permissions' },
    },
  ];

  readonly nav = computed(() => {
    // Recomputes when the caller signal lands, so the menu appears with the
    // permissions rather than before them.
    this.caller();
    return this.allNav.filter(
      (item) =>
        item.requires === undefined ||
        this.auth.canInvoke(item.requires.method, item.requires.path),
    );
  });

  async ngOnInit(): Promise<void> {
    try {
      await this.i18n.load();

      // A session may already exist from a previous visit: restore it before
      // asking who the caller is, or a returning user sees the signed-out
      // shell until they navigate.
      await this.auth.restore();
      await this.auth.loadCaller();
    } catch (error) {
      this.loadError.set(error instanceof Error ? error.message : 'The API could not be reached');
    } finally {
      this.ready.set(true);
    }
  }

  async switchLanguage(code: string): Promise<void> {
    await this.i18n.load(code);
  }

  async logout(): Promise<void> {
    await this.auth.logout();
  }
}
