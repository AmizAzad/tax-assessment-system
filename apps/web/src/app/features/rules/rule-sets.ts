import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AssessmentService } from '../../core/assessment.service';
import { AmountPipe, EmptyState, ErrorAlert, StatusBadge, describeError } from '../../shared/ui';

/**
 * Rule sets, and the simulator.
 *
 * Plan reference: V2 sections 11.4, 11.5.
 *
 * ## Why simulation sits next to publication
 *
 * Publishing a rule set changes every case computed after it. A rate table
 * cannot tell anybody what that will do: a fraction changed in the fourth
 * decimal place can move a hundred million, and a band boundary moved by a
 * pound can move nobody at all.
 *
 * So the simulator is on the same screen as the publish control, showing the
 * total movement and the largest individual swings, and it is meant to be run
 * first. Publication also needs a second pair of eyes: the API refuses a
 * publisher who authored the set.
 */
@Component({
  selector: 'tas-rule-sets',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, AmountPipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Tax rule sets</h1>
        <p class="tas-muted">
          Rates, bands, penalties and interest as configuration. Adding a jurisdiction is data, not
          a release.
        </p>
      </div>
    </div>

    <tas-error [message]="error()" />

    <div class="tas-card">
      @if (rows().length === 0) {
        <tas-empty>No rule sets configured.</tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Scope</th>
              <th>Version</th>
              <th>Status</th>
              <th>Effective</th>
              <th>Currency</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track $index) {
              <tr>
                <td>
                  <code>{{ row['code'] }}</code>
                </td>
                <td>{{ row['jurisdiction_code'] }} {{ row['tax_type_code'] }}</td>
                <td>{{ row['version'] }}</td>
                <td><tas-status [status]="text(row['status'])" /></td>
                <td class="tas-muted">
                  {{ row['effective_from'] }} → {{ row['effective_to'] ?? 'open' }}
                </td>
                <td>{{ row['currency_code'] }}</td>
                <td>
                  @if (text(row['status']) === 'DRAFT') {
                    <button type="button" class="tas-btn" (click)="simulate(num(row['id']))">
                      Simulate
                    </button>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>

    @if (simulation(); as s) {
      <div class="tas-card" style="margin-block-start:1rem">
        <h2 style="margin-top:0">Simulation of {{ s['draftRuleSet'] }}</h2>
        <p class="tas-muted">
          Replayed over {{ s['casesCompared'] }} finalised case(s). Nothing was persisted.
        </p>

        <dl class="tas-facts">
          <div>
            <dt>Currently assessed</dt>
            <dd class="tas-amount">{{ text(s['totalCurrent']) | tasAmount }}</dd>
          </div>
          <div>
            <dt>Under the draft</dt>
            <dd class="tas-amount">{{ text(s['totalSimulated']) | tasAmount }}</dd>
          </div>
          <div>
            <dt>Movement</dt>
            <dd
              class="tas-amount"
              [class.tas-amount--negative]="text(s['totalMovement']).startsWith('-')"
            >
              {{ text(s['totalMovement']) | tasAmount }} {{ s['currency'] }}
            </dd>
          </div>
          <div>
            <dt>Up / down / unchanged</dt>
            <dd>{{ s['increased'] }} / {{ s['decreased'] }} / {{ s['unchanged'] }}</dd>
          </div>
          <div>
            <dt>Failed to compute</dt>
            <dd [style.color]="num(s['casesFailed']) > 0 ? 'var(--tas-danger)' : ''">
              {{ s['casesFailed'] }}
            </dd>
          </div>
        </dl>

        @if (num(s['casesFailed']) > 0) {
          <div class="tas-alert tas-alert--danger" style="margin-block-start:1rem">
            The draft could not compute every historic case. That is a finding about the draft, not
            about the cases.
          </div>
        }

        <h3>Largest increases</h3>
        <table class="tas-table">
          <thead>
            <tr>
              <th>Case</th>
              <th style="text-align:end">Now</th>
              <th style="text-align:end">Under the draft</th>
              <th style="text-align:end">Movement</th>
            </tr>
          </thead>
          <tbody>
            @for (line of lines(s['biggestIncreases']); track $index) {
              <tr>
                <td>{{ line['caseNumber'] }}</td>
                <td class="tas-amount">{{ text(line['currentNet']) | tasAmount }}</td>
                <td class="tas-amount">{{ text(line['simulatedNet']) | tasAmount }}</td>
                <td class="tas-amount">{{ text(line['movement']) | tasAmount }}</td>
              </tr>
            }
          </tbody>
        </table>

        <h3>Largest decreases</h3>
        <table class="tas-table">
          <thead>
            <tr>
              <th>Case</th>
              <th style="text-align:end">Now</th>
              <th style="text-align:end">Under the draft</th>
              <th style="text-align:end">Movement</th>
            </tr>
          </thead>
          <tbody>
            @for (line of lines(s['biggestDecreases']); track $index) {
              <tr>
                <td>{{ line['caseNumber'] }}</td>
                <td class="tas-amount">{{ text(line['currentNet']) | tasAmount }}</td>
                <td class="tas-amount">{{ text(line['simulatedNet']) | tasAmount }}</td>
                <td class="tas-amount tas-amount--negative">
                  {{ text(line['movement']) | tasAmount }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Notice wording</h2>
      <p class="tas-muted">
        Templates substitute values and nothing else. One that could compute could contradict the
        approved calculation.
      </p>
      @if (templates().length === 0) {
        <tas-empty>No notice templates configured.</tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Jurisdiction</th>
              <th>Type</th>
              <th>Language</th>
              <th>Status</th>
              <th>Title</th>
            </tr>
          </thead>
          <tbody>
            @for (template of templates(); track $index) {
              <tr>
                <td>{{ template['jurisdiction_code'] }}</td>
                <td>{{ template['notice_type'] }}</td>
                <td>{{ template['language_code'] }}</td>
                <td><tas-status [status]="text(template['status'])" /></td>
                <td class="tas-muted">{{ template['title_template'] }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class RuleSets implements OnInit {
  private readonly assessment = inject(AssessmentService);

  readonly rows = signal<readonly Record<string, unknown>[]>([]);
  readonly templates = signal<readonly Record<string, unknown>[]>([]);
  readonly simulation = signal<Record<string, unknown> | null>(null);
  readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.rows.set(await this.assessment.ruleSets());
      this.templates.set(await this.assessment.noticeTemplates());
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  async simulate(id: number): Promise<void> {
    this.error.set(null);
    this.simulation.set(null);
    try {
      this.simulation.set(await this.assessment.simulate(id));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  text(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  num(value: unknown): number {
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  lines(value: unknown): readonly Record<string, unknown>[] {
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  }
}
