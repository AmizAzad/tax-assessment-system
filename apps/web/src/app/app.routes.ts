import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';

/**
 * Application routes.
 *
 * Every route except the auth callback is guarded. The guard is a UX measure
 * — it sends an unauthenticated user to the IdP rather than showing an empty
 * screen. It is not a security control: the API denies regardless.
 */
export const routes: Routes = [
  {
    path: 'auth/callback',
    loadComponent: () => import('./features/auth/callback').then((m) => m.AuthCallback),
  },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/home/home').then((m) => m.Home),
      },
      {
        path: 'masters',
        loadComponent: () => import('./features/masters/masters').then((m) => m.Masters),
      },
      {
        path: 'forms',
        loadComponent: () => import('./features/forms/form-list').then((m) => m.FormList),
      },
      {
        path: 'forms/builder',
        loadComponent: () => import('./features/builder/form-builder').then((m) => m.FormBuilder),
      },
      {
        path: 'forms/preview',
        loadComponent: () => import('./features/forms/form-preview').then((m) => m.FormPreview),
      },
      {
        path: 'portal',
        loadComponent: () => import('./features/portal/portal').then((m) => m.Portal),
      },
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'processes',
        loadComponent: () =>
          import('./features/processes/process-modeler').then((m) => m.ProcessModeler),
      },
      {
        path: 'cases',
        loadComponent: () => import('./features/cases/case-register').then((m) => m.CaseRegister),
      },
      {
        path: 'cases/:id',
        loadComponent: () => import('./features/cases/case-detail').then((m) => m.CaseDetail),
      },
      {
        path: 'queues',
        loadComponent: () => import('./features/queues/queues').then((m) => m.Queues),
      },
      {
        path: 'selection',
        loadComponent: () => import('./features/selection/selection').then((m) => m.Selection),
      },
      {
        path: 'rules',
        loadComponent: () => import('./features/rules/rule-sets').then((m) => m.RuleSets),
      },
      {
        path: 'disputes',
        loadComponent: () =>
          import('./features/disputes/dispute-register').then((m) => m.DisputeRegister),
      },
      {
        path: 'reports',
        loadComponent: () => import('./features/reports/reports').then((m) => m.Reports),
      },
      {
        path: 'admin',
        loadComponent: () => import('./features/admin/admin').then((m) => m.Admin),
      },
      {
        path: 'tasks',
        loadComponent: () => import('./features/tasks/task-inbox').then((m) => m.TaskInbox),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
