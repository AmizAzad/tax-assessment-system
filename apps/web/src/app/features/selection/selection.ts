import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AssessmentService } from '../../core/assessment.service';
import { AuthService } from '../../core/auth.service';
import { EmptyState, ErrorAlert, describeError } from '../../shared/ui';

/**
 * Risk-based selection.
 *
 * Plan reference: V2 sections 8.1, 8.2 stage 1.
 *
 * ## Scoring and opening are two screens' worth of decision, one after the other
 *
 * The run scores every registered taxpayer and opens nothing. The candidates
 * are then shown with the rules that fired on each, and opening cases is a
 * second, explicit action with its own cap.
 *
 * That separation is the point. Selection decides who a revenue authority
 * investigates, and an officer should see *why* a company was picked before
 * committing the authority to assessing it.
 */
@Component({
  selector: 'tas-selection',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, EmptyState, ErrorAlert],
  template: `
    <div class="tas-page-head">
      <div>
        <h1>Risk selection</h1>
        <p class="tas-muted">
          Scores taxpayers against the rules in force. Opening cases is a separate act.
        </p>
      </div>
    </div>

    <tas-error [message]="error()" />

    <!-- Choosing who gets assessed is the supervisor's and the administrator's
         act. Anyone else who reads this screen sees the rules and the runs,
         not a form the API will refuse. -->
    @if (canRun()) {
      <div class="tas-card">
        <h2 style="margin-top:0">Run a selection</h2>
        <div class="tas-grid">
          <div class="tas-field">
            <label for="sel-jurisdiction">Jurisdiction</label>
            <input id="sel-jurisdiction" [(ngModel)]="jurisdictionCode" />
          </div>
          <div class="tas-field">
            <label for="sel-taxtype">Tax type</label>
            <input id="sel-taxtype" [(ngModel)]="taxTypeCode" />
          </div>
          <div class="tas-field">
            <label for="sel-year">Assessment year</label>
            <input id="sel-year" [(ngModel)]="assessmentYear" />
          </div>
          <div class="tas-field">
            <label for="sel-threshold">Score threshold</label>
            <input id="sel-threshold" type="number" [(ngModel)]="scoreThreshold" />
            <span class="tas-field__hint">
              A rule marked mandatory selects a taxpayer whatever the total.
            </span>
          </div>
        </div>
        <div class="tas-row" style="margin-block-start:1rem">
          <button
            type="button"
            class="tas-btn tas-btn--primary"
            [disabled]="busy()"
            (click)="run()"
          >
            {{ busy() ? 'Scoring…' : 'Score taxpayers' }}
          </button>
        </div>
      </div>
    }

    @if (result(); as r) {
      <div class="tas-card" style="margin-block-start:1rem">
        <div class="tas-page-head" style="margin-block-end:0.5rem">
          <div>
            <h2 style="margin:0">Run {{ r.runId }}</h2>
            <p class="tas-muted" style="margin:0.25rem 0 0">
              {{ r.candidates.length }} scored, {{ selectedCount(r) }} at or above
              {{ r.threshold }}.
            </p>
          </div>
          <div class="tas-row">
            <input
              type="number"
              class="tas-input"
              aria-label="Most cases to open"
              [(ngModel)]="maxCases"
              style="width:6rem"
            />
            <button type="button" class="tas-btn tas-btn--primary" (click)="openCases(r.runId)">
              Open cases
            </button>
          </div>
        </div>

        @if (opened(); as o) {
          <div class="tas-alert">
            Opened {{ o.opened }} case(s){{ o.skipped ? ', skipped ' + o.skipped : '' }}:
            {{ o.caseNumbers.join(', ') }}
          </div>
        }

        <table class="tas-table">
          <thead>
            <tr>
              <th>TIN</th>
              <th>Taxpayer</th>
              <th class="tas-amount">Score</th>
              <th>Selected</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            @for (candidate of r.candidates; track candidate.taxpayerId) {
              <tr>
                <td>
                  <code>{{ candidate.tin }}</code>
                </td>
                <td>{{ candidate.name }}</td>
                <td class="tas-amount">{{ candidate.totalScore }}</td>
                <td>
                  @if (candidate.selected) {
                    <span class="tas-badge tas-badge--active">Selected</span>
                  } @else {
                    <span class="tas-muted">—</span>
                  }
                </td>
                <td>
                  @for (rule of candidate.matchedRules; track rule.ruleCode) {
                    <div style="font-size:0.82rem">
                      <code>{{ rule.ruleCode }}</code> (+{{ rule.weight }}) — {{ rule.detail }}
                    </div>
                  }
                  @if (candidate.suppressedReason) {
                    <div class="tas-muted" style="font-size:0.82rem">
                      {{ candidate.suppressedReason }}
                    </div>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Rules in force</h2>
      <p class="tas-muted">
        Each names an indicator the platform implements. Thresholds and weights are configuration;
        the meaning of an indicator deliberately is not.
      </p>
      @if (rules().length === 0) {
        <tas-empty>No risk rules configured.</tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Indicator</th>
              <th>Parameters</th>
              <th class="tas-amount">Weight</th>
              <th>Mandatory</th>
            </tr>
          </thead>
          <tbody>
            @for (rule of rules(); track $index) {
              <tr>
                <td>
                  <code>{{ rule['rule_code'] }}</code>
                  <div class="tas-muted" style="font-size:0.8rem">
                    {{ rule['jurisdiction_code'] }} {{ rule['tax_type_code'] }}
                  </div>
                </td>
                <td>
                  <code>{{ rule['indicator_code'] }}</code>
                </td>
                <td class="tas-muted" style="font-size:0.8rem">
                  {{ stringify(rule['parameters_json']) }}
                </td>
                <td class="tas-amount">{{ rule['weight'] }}</td>
                <td>{{ rule['is_mandatory_referral'] ? 'Yes' : 'No' }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>

    <div class="tas-card" style="margin-block-start:1rem">
      <h2 style="margin-top:0">Previous runs</h2>
      @if (runs().length === 0) {
        <tas-empty>No selection has been run.</tas-empty>
      } @else {
        <table class="tas-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Campaign</th>
              <th>When</th>
              <th class="tas-amount">Scored</th>
              <th class="tas-amount">Selected</th>
              <th class="tas-amount">Opened</th>
            </tr>
          </thead>
          <tbody>
            @for (previous of runs(); track $index) {
              <tr>
                <td>{{ previous['id'] }}</td>
                <td>
                  <code>{{ previous['campaign_code'] }}</code>
                </td>
                <td class="tas-muted">
                  {{ asDate(previous['run_at']) | date: 'yyyy-MM-dd HH:mm' }}
                </td>
                <td class="tas-amount">{{ previous['candidate_count'] }}</td>
                <td class="tas-amount">{{ previous['selected_count'] }}</td>
                <td class="tas-amount">{{ previous['cases_opened'] }}</td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
})
export class Selection implements OnInit {
  private readonly assessment = inject(AssessmentService);
  private readonly auth = inject(AuthService);

  readonly result = signal<Awaited<ReturnType<AssessmentService['runSelection']>> | null>(null);
  readonly runs = signal<readonly Record<string, unknown>[]>([]);
  readonly rules = signal<readonly Record<string, unknown>[]>([]);
  readonly opened = signal<{
    opened: number;
    skipped: number;
    caseNumbers: readonly string[];
  } | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  jurisdictionCode = 'GB';
  taxTypeCode = 'CIT';
  assessmentYear = '2024';
  scoreThreshold = 30;
  maxCases = 25;

  async ngOnInit(): Promise<void> {
    await this.loadSupporting();
  }

  private async loadSupporting(): Promise<void> {
    try {
      this.rules.set(await this.assessment.riskRules());
      this.runs.set(await this.assessment.selectionRuns());
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  selectedCount(result: Awaited<ReturnType<AssessmentService['runSelection']>>): number {
    return result.candidates.filter((candidate) => candidate.selected).length;
  }

  async run(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    this.opened.set(null);
    try {
      this.result.set(
        await this.assessment.runSelection({
          jurisdictionCode: this.jurisdictionCode,
          taxTypeCode: this.taxTypeCode,
          assessmentYear: this.assessmentYear,
          scoreThreshold: Number(this.scoreThreshold),
        }),
      );
      await this.loadSupporting();
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async openCases(runId: number): Promise<void> {
    this.error.set(null);
    try {
      this.opened.set(await this.assessment.openCasesFromRun(runId, Number(this.maxCases)));
      await this.loadSupporting();
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  stringify(value: unknown): string {
    return value === null || value === undefined ? '' : JSON.stringify(value);
  }

  asDate(value: unknown): string {
    return typeof value === 'string' ? value : String(value ?? '');
  }

  canRun(): boolean {
    return this.auth.canInvoke('POST', '/api/v1/selection/runs');
  }
}
