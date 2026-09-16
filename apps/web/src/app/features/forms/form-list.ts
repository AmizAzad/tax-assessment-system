import { Component, ChangeDetectionStrategy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/api.service';

interface TemplateSummary {
  readonly id: number;
  readonly templateCode: string;
  readonly version: number;
  readonly displayKey: string;
  readonly status: string;
  readonly appliesToYear?: string;
}

/**
 * Form template catalogue.
 *
 * Templates are versioned by clone-per-year and a published one is immutable
 * (plan 4.3), so several versions of a code coexist by design — the list shows
 * them rather than collapsing to the latest.
 */
@Component({
  selector: 'tas-form-list',
  standalone: true,
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Form templates</h1>
    <p class="tas-muted">
      Assessment forms are configuration. A published template is immutable — changes go to a new
      version, so a historic submission stays renderable against the template that produced it.
    </p>

    <p>
      <a class="tas-btn tas-btn--primary" routerLink="/forms/builder">Open the builder</a>
      <a class="tas-btn" routerLink="/forms/preview">Renderer demo</a>
    </p>

    @if (error(); as message) {
      <div class="tas-alert tas-alert--danger" role="alert">{{ message }}</div>
    } @else if (templates().length === 0) {
      <div class="tas-card">
        <p class="tas-muted">No templates have been authored yet.</p>
        <p class="tas-muted">
          The 18 assessment templates are configured in Phases 2 to 7. The renderer demo above
          exercises the engine against a definition held in code.
        </p>
      </div>
    } @else {
      <table class="tas-table">
        <thead>
          <tr>
            <th>Code</th>
            <th>Version</th>
            <th>Name</th>
            <th>Status</th>
            <th>Year</th>
          </tr>
        </thead>
        <tbody>
          @for (template of templates(); track template.id) {
            <tr>
              <td>
                <code>{{ template.templateCode }}</code>
              </td>
              <td>v{{ template.version }}</td>
              <td>{{ template.displayKey }}</td>
              <td>{{ template.status }}</td>
              <td>{{ template.appliesToYear ?? '—' }}</td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
})
export class FormList implements OnInit {
  private readonly api = inject(ApiService);

  readonly templates = signal<readonly TemplateSummary[]>([]);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.templates.set(await this.api.get<TemplateSummary[]>('/forms/templates'));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Could not load templates');
    }
  }
}
