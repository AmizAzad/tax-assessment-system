import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { AssessmentService } from '../../../core/assessment.service';
import type { CalculationDelta, StoredCalculation } from '../../../core/domain';
import { AmountPipe, EmptyState, ErrorAlert, describeError } from '../../../shared/ui';
import { canRework } from './case-rules';

/**
 * The authoritative calculation, and the trace that explains it.
 *
 * Plan reference: V2 sections 11.1, 11.2; ADR-006.
 *
 * ## Nothing on this screen is computed here
 *
 * Every figure, including the trace lines and the movement between versions,
 * is rendered exactly as the API returned it. The browser does no arithmetic:
 * that is the governing rule of the whole system, and a subtotal computed in a
 * template would be a second implementation of the tax law that nobody
 * reviewed.
 *
 * ## Why the trace is the main event
 *
 * A reviewer has to be able to check the figure by hand. The trace shows the
 * arithmetic of every step in order, which is why it is monospaced, always
 * expanded, and given more room than the summary above it.
 */
@Component({
  selector: 'tas-case-calculation',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, AmountPipe, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <div class="tas-page-head" style="margin-block-end:0.5rem">
        <div>
          <h2 style="margin:0">Calculation</h2>
          <p class="tas-muted" style="margin:0.25rem 0 0">
            Computed on the server against the rule set in force for the period. The browser
            displays; it never calculates.
          </p>
        </div>
        <div class="tas-row">
          @if (history().length > 1) {
            <button type="button" class="tas-btn" [disabled]="busy()" (click)="loadDelta()">
              What changed
            </button>
          }
          @if (canCalculate && canRework(status)) {
            <button
              type="button"
              class="tas-btn tas-btn--primary"
              [disabled]="busy()"
              (click)="calculate()"
            >
              {{ busy() ? 'Calculating…' : 'Calculate' }}
            </button>
          }
        </div>
      </div>

      @if (current(); as calc) {
        <p class="tas-muted">
          Version {{ calc.version }} · rule set <code>{{ calc.ruleSetCode }}</code> v{{
            calc.ruleSetVersion
          }}
          · {{ calc.calculatedAt | date: 'yyyy-MM-dd HH:mm' }}
        </p>

        <table class="tas-table" style="max-width:34rem">
          <tbody>
            <tr>
              <td>Declared</td>
              <td class="tas-amount">{{ calc.declaredBase | tasAmount }}</td>
            </tr>
            <tr>
              <td>Adjustments</td>
              <td class="tas-amount">{{ calc.totalAdjustments | tasAmount }}</td>
            </tr>
            <tr>
              <td>Assessed base</td>
              <td class="tas-amount">{{ calc.assessedBase | tasAmount }}</td>
            </tr>
            <tr>
              <td>Losses set off</td>
              <td class="tas-amount">{{ calc.lossesSetOff | tasAmount }}</td>
            </tr>
            <tr>
              <td><strong>Taxable base</strong></td>
              <td class="tas-amount">
                <strong>{{ calc.taxableBase | tasAmount }}</strong>
              </td>
            </tr>
            <tr>
              <td>Tax before credits</td>
              <td class="tas-amount">{{ calc.taxBeforeCredits | tasAmount }}</td>
            </tr>
            <tr>
              <td>Credits</td>
              <td class="tas-amount">{{ calc.totalCredits | tasAmount }}</td>
            </tr>
            <tr>
              <td>Penalty</td>
              <td class="tas-amount">{{ calc.penaltyAmount | tasAmount }}</td>
            </tr>
            <tr>
              <td>Interest</td>
              <td class="tas-amount">{{ calc.interestAmount | tasAmount }}</td>
            </tr>
            <tr>
              <td><strong>Net payable</strong></td>
              <td class="tas-amount">
                <strong
                  >{{ calc.netPayableOrRefundable | tasAmount }} {{ calc.currencyCode }}</strong
                >
              </td>
            </tr>
          </tbody>
        </table>
      } @else {
        <tas-empty>
          No calculation yet. The assessor calculates once the evidence is in and any adjustments
          are recorded.
        </tas-empty>
      }
    </div>

    @if (current(); as calc) {
      <div class="tas-card" style="margin-block-start:1rem">
        <h3>How this figure was reached</h3>
        <p class="tas-muted">
          Every line is arithmetic you can check by hand. That is the test a trace has to pass.
        </p>
        <table class="tas-table tas-trace">
          <thead>
            <tr>
              <th style="width:3rem">#</th>
              <th style="width:12rem">Step</th>
              <th>Working</th>
              <th class="tas-amount">Result</th>
            </tr>
          </thead>
          <tbody>
            @for (entry of calc.trace; track entry.sequence) {
              <tr>
                <td class="tas-trace__step">{{ entry.sequence }}</td>
                <td class="tas-trace__step">
                  {{ entry.step }}
                  @if (entry.ruleReference) {
                    <div style="font-size:0.7rem">{{ entry.ruleReference }}</div>
                  }
                </td>
                <td>{{ entry.expression }}</td>
                <td class="tas-amount">{{ entry.output | tasAmount }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    @if (delta(); as d) {
      <div class="tas-card" style="margin-block-start:1rem">
        <h3>
          Movement from version {{ d.from ?? '—' }} to {{ d.to }}:
          <span [class.tas-amount--negative]="d.direction === 'DECREASE'">
            {{ d.netMovement | tasAmount }} {{ d.currencyCode }}
          </span>
        </h3>
        <table class="tas-table">
          <thead>
            <tr>
              <th>Line</th>
              <th class="tas-amount">Previous</th>
              <th class="tas-amount">Revised</th>
              <th class="tas-amount">Movement</th>
            </tr>
          </thead>
          <tbody>
            @for (line of d.lines; track line.label) {
              <tr [style.opacity]="line.movement === '0.00' ? 0.5 : 1">
                <td>{{ line.label }}</td>
                <td class="tas-amount">{{ line.previous | tasAmount }}</td>
                <td class="tas-amount">{{ line.revised | tasAmount }}</td>
                <td class="tas-amount" [class.tas-amount--negative]="line.movement.startsWith('-')">
                  {{ line.movement | tasAmount }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    @if (history().length > 1) {
      <div class="tas-card" style="margin-block-start:1rem">
        <h3>Versions</h3>
        <p class="tas-muted">
          Every recalculation is kept. "The officer asked for a recalculation at this time" is
          itself a fact worth recording.
        </p>
        <table class="tas-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Rule set</th>
              <th>Calculated</th>
              <th class="tas-amount">Net payable</th>
            </tr>
          </thead>
          <tbody>
            @for (version of history(); track version.version) {
              <tr>
                <td>{{ version.version }}</td>
                <td>
                  <code>{{ version.ruleSetCode }}</code>
                </td>
                <td>{{ version.calculatedAt | date: 'yyyy-MM-dd HH:mm' }}</td>
                <td class="tas-amount">{{ version.netPayableOrRefundable | tasAmount }}</td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class CaseCalculation implements OnInit {
  private readonly assessment = inject(AssessmentService);

  @Input({ required: true }) caseId!: number;
  @Input() status = '';
  /** Whether the caller holds the route that calculates. */
  @Input() canCalculate = false;
  @Output() readonly changed = new EventEmitter<void>();

  readonly canRework = canRework;

  readonly current = signal<StoredCalculation | null>(null);
  readonly history = signal<readonly StoredCalculation[]>([]);
  readonly delta = signal<CalculationDelta | null>(null);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    try {
      this.current.set(await this.assessment.currentCalculation(this.caseId));
      this.history.set(await this.assessment.calculationHistory(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  async calculate(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      this.current.set(await this.assessment.calculate(this.caseId));
      this.history.set(await this.assessment.calculationHistory(this.caseId));
      this.changed.emit();
    } catch (error) {
      // A refusal here is usually a frozen case or a missing rule set, and the
      // server says which.
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async loadDelta(): Promise<void> {
    this.error.set(null);
    try {
      this.delta.set(await this.assessment.delta(this.caseId));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }
}
