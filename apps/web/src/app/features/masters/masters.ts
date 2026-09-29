import { Component, ChangeDetectionStrategy, OnInit, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service';
import { humanise } from '../../core/domain';
import { I18nService } from '../../core/i18n.service';
import { describeError } from '../../shared/ui';

interface MasterItem {
  readonly itemCode: string;
  readonly displayKey: string;
  readonly sortOrder: number;
}

interface MasterGroup {
  readonly groupCode: string;
  readonly jurisdictionCode?: string;
  readonly displayKey: string;
  readonly items: readonly MasterItem[];
}

/**
 * Reference data browser.
 *
 * These catalogues are jurisdiction configuration (plan 6.2), so being able to
 * see what a deployment actually holds is the fastest way to check a seed did
 * what was intended.
 */
@Component({
  selector: 'tas-masters',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Reference data</h1>
    <p class="tas-muted">
      Jurisdiction catalogues. Adding a code here is configuration, not a release.
    </p>

    <div class="tas-groups">
      @for (code of groupCodes; track code) {
        <button
          type="button"
          class="tas-btn"
          [class.tas-btn--primary]="selected() === code"
          (click)="select(code)"
        >
          {{ readable(code) }}
        </button>
      }
    </div>

    @if (error(); as message) {
      <div class="tas-alert tas-alert--danger" role="alert">{{ message }}</div>
    } @else if (group(); as g) {
      <div class="tas-card" style="margin-top:1rem">
        <h2>{{ readable(g.groupCode) }}</h2>
        <p class="tas-muted">
          <code>{{ g.displayKey }}</code> · jurisdiction {{ g.jurisdictionCode ?? 'any' }}
        </p>
        <table class="tas-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Code</th>
              <th>Display key</th>
              <th class="tas-amount">Order</th>
            </tr>
          </thead>
          <tbody>
            @for (item of g.items; track item.itemCode) {
              <tr>
                <td>{{ label(item) }}</td>
                <td>
                  <code>{{ item.itemCode }}</code>
                </td>
                <td class="tas-muted">{{ item.displayKey }}</td>
                <td class="tas-amount">{{ item.sortOrder }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: [
    `
      .tas-groups {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        margin: 1rem 0;
      }
    `,
  ],
})
export class Masters implements OnInit {
  private readonly api = inject(ApiService);
  private readonly i18n = inject(I18nService);

  readonly groupCodes = [
    'ADJUSTMENT_TYPE',
    'ADJUSTMENT_REASON',
    'OBJECTION_GROUND',
    'APPEAL_FORUM',
    'CLOSURE_REASON',
  ];

  readonly selected = signal<string>(this.groupCodes[0]!);
  readonly group = signal<MasterGroup | null>(null);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.load(this.selected());
  }

  async select(code: string): Promise<void> {
    this.selected.set(code);
    await this.load(code);
  }

  private async load(code: string): Promise<void> {
    this.error.set(null);
    try {
      this.group.set(await this.api.get<MasterGroup>(`/masters/${code}`));
    } catch (error) {
      this.group.set(null);
      this.error.set(describeError(error));
    }
  }

  /** `ADJUSTMENT_TYPE` becomes `Adjustment type`; the code stays in the table. */
  readable(code: string): string {
    return humanise(code);
  }

  /**
   * The label an officer sees in a dropdown. Falls back to the humanised code
   * while a jurisdiction has not recorded one, so the column reads as words
   * rather than as the key a translator has yet to fill.
   */
  label(item: MasterItem): string {
    return this.i18n.t(item.displayKey, humanise(item.itemCode));
  }
}
