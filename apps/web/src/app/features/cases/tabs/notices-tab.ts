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
import { FormsModule } from '@angular/forms';
import { AssessmentService } from '../../../core/assessment.service';
import { APP_CONFIG } from '../../../core/config';
import type { Notice } from '../../../core/domain';
import { EmptyState, ErrorAlert, StatusBadge, describeError } from '../../../shared/ui';

/**
 * Notices: issue, verify, serve, and prove.
 *
 * Plan reference: V2 sections 12.1 to 12.6.
 *
 * ## Why verification is a button and not a badge
 *
 * Showing a green tick automatically would mean the check runs on every page
 * load and is ignored by everybody. Verification answers a specific question
 * asked at a specific moment -- usually during a dispute -- so it is an action
 * whose result is stated plainly, including the two hashes.
 *
 * ## Why the deemed service date is shown on every attempt
 *
 * It is the date the objection window runs from, and it is not the date of
 * despatch. An officer looking at a returned letter and an email sent the same
 * day needs to see which of them started the clock.
 */
@Component({
  selector: 'tas-case-notices',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, StatusBadge, EmptyState, ErrorAlert],
  template: `
    <tas-error [message]="error()" />

    <div class="tas-card">
      <div class="tas-page-head" style="margin-block-end:0.5rem">
        <div>
          <h2 style="margin:0">Notices</h2>
          <p class="tas-muted" style="margin:0.25rem 0 0">
            A notice gives legal effect to the determination, so it may only be issued from a
            finalised assessment. Re-issuing creates a new version; the taxpayer may hold the old
            one.
          </p>
        </div>
        <div class="tas-row">
          <select [(ngModel)]="noticeType" class="tas-btn">
            <option value="ASSESSMENT">Assessment</option>
            <option value="DEMAND">Demand</option>
          </select>
          <button
            type="button"
            class="tas-btn tas-btn--primary"
            [disabled]="busy()"
            (click)="generate()"
          >
            Issue notice
          </button>
        </div>
      </div>
    </div>

    @if (rows().length === 0) {
      <div class="tas-card" style="margin-block-start:1rem">
        <tas-empty>No notices issued. Nothing has been served on the taxpayer yet.</tas-empty>
      </div>
    }

    @for (notice of rows(); track notice.uuid) {
      <div class="tas-card" style="margin-block-start:1rem">
        <div class="tas-page-head" style="margin-block-end:0.5rem">
          <div>
            <h3 style="margin:0; display:flex; gap:0.75rem; align-items:center">
              {{ notice.noticeNumber }}
              <tas-status [status]="notice.status" />
            </h3>
            <p class="tas-muted" style="margin:0.25rem 0 0">
              Version {{ notice.version }} · {{ notice.languageCode }} · issued
              {{ notice.issuedAt | date: 'yyyy-MM-dd' }}
              @if (notice.deemedServedOn) {
                · deemed served {{ notice.deemedServedOn }}
              }
            </p>
          </div>
          <div class="tas-row">
            <button type="button" class="tas-btn" (click)="verify(notice.uuid)">Verify</button>
            @if (notice.documentUuid) {
              <a class="tas-btn" [href]="documentUrl(notice.uuid)" target="_blank" rel="noopener">
                Download PDF
              </a>
            }
            <button type="button" class="tas-btn" (click)="toggle(notice.uuid)">
              {{ expanded() === notice.uuid ? 'Hide' : 'Read' }}
            </button>
          </div>
        </div>

        @if (verification(); as v) {
          @if (v.noticeNumber === notice.noticeNumber) {
            <div class="tas-alert" [class.tas-alert--danger]="!v.intact">
              <strong>{{ v.intact ? 'Unaltered' : 'ALTERED SINCE ISSUE' }}</strong>
              <p class="tas-alert__hint" style="font-family:monospace; font-size:0.75rem">
                stored {{ v.storedHash.slice(0, 32) }}…<br />
                recomputed {{ v.recomputedHash.slice(0, 32) }}…
              </p>
            </div>
          }
        }

        @if (expanded() === notice.uuid) {
          <pre
            style="white-space:pre-wrap; background:var(--tas-surface-muted); padding:1rem; border-radius:6px; font-size:0.85rem"
            >{{ notice.body }}</pre>
        }

        <h4 style="margin-block-end:0.5rem">Service</h4>
        @if ((notice.serviceAttempts ?? []).length === 0) {
          <p class="tas-muted">Not yet served. Until it is, no objection window is running.</p>
        } @else {
          <table class="tas-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Addressee</th>
                <th>Despatched</th>
                <th>Deemed served</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              @for (attempt of notice.serviceAttempts ?? []; track attempt.id) {
                <tr>
                  <td>{{ attempt.channel }}</td>
                  <td class="tas-muted">{{ attempt.addressee }}</td>
                  <td>{{ attempt.dispatchedAt | date: 'yyyy-MM-dd' }}</td>
                  <td>{{ attempt.deemedServedOn ?? '—' }}</td>
                  <td>
                    <tas-status [status]="attempt.status" />
                    @if (attempt.failureReason) {
                      <div class="tas-muted" style="font-size:0.8rem">
                        {{ attempt.failureReason }}
                      </div>
                    }
                    @if (attempt.status === 'DISPATCHED') {
                      <div class="tas-row" style="margin-block-start:0.35rem">
                        <button
                          type="button"
                          class="tas-btn"
                          (click)="outcome(notice.uuid, attempt.id, 'DELIVERED')"
                        >
                          Delivered
                        </button>
                        <button
                          type="button"
                          class="tas-btn tas-btn--danger"
                          (click)="outcome(notice.uuid, attempt.id, 'RETURNED')"
                        >
                          Returned
                        </button>
                      </div>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }

        <div class="tas-grid" style="margin-block-start:1rem">
          <div class="tas-field">
            <label [attr.for]="'ch-' + notice.uuid">Channel</label>
            <select [attr.id]="'ch-' + notice.uuid" [(ngModel)]="channel">
              <option value="EMAIL">Email</option>
              <option value="PORTAL">Portal</option>
              <option value="SMS">SMS</option>
              <option value="REGISTERED_POST">Registered post</option>
              <option value="HAND_DELIVERY">Hand delivery</option>
              <option value="PUBLICATION">Publication</option>
            </select>
          </div>
          <div class="tas-field">
            <label [attr.for]="'ad-' + notice.uuid">Addressee</label>
            <input [attr.id]="'ad-' + notice.uuid" [(ngModel)]="addressee" />
          </div>
          <div class="tas-field">
            <label [attr.for]="'pr-' + notice.uuid">Proof reference</label>
            <input
              [attr.id]="'pr-' + notice.uuid"
              [(ngModel)]="proofReference"
              placeholder="Tracking number"
            />
          </div>
        </div>
        <div class="tas-row" style="margin-block-start:0.75rem">
          <button
            type="button"
            class="tas-btn tas-btn--primary"
            [disabled]="busy()"
            (click)="serve(notice.uuid)"
          >
            Serve
          </button>
        </div>
      </div>
    }
  `,
})
export class CaseNotices implements OnInit {
  private readonly assessment = inject(AssessmentService);

  @Input({ required: true }) caseId!: number;
  @Input() status = '';
  @Output() readonly changed = new EventEmitter<void>();

  readonly rows = signal<readonly Notice[]>([]);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  readonly expanded = signal<string | null>(null);
  readonly verification = signal<{
    noticeNumber: string;
    intact: boolean;
    storedHash: string;
    recomputedHash: string;
  } | null>(null);

  noticeType = 'ASSESSMENT';
  channel = 'EMAIL';
  addressee = '';
  proofReference = '';

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    try {
      const list = await this.assessment.notices(this.caseId);
      // The list endpoint omits the service attempts, which are the part an
      // officer actually works from, so each notice is re-read in full.
      this.rows.set(await Promise.all(list.map((n) => this.assessment.notice(n.uuid))));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  documentUrl(uuid: string): string {
    return `${APP_CONFIG.apiBaseUrl}/api/v1/notices/${uuid}/document`;
  }

  toggle(uuid: string): void {
    this.expanded.set(this.expanded() === uuid ? null : uuid);
  }

  async generate(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.assessment.generateNotice(this.caseId, this.noticeType);
      await this.load();
      this.changed.emit();
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async verify(uuid: string): Promise<void> {
    this.error.set(null);
    try {
      this.verification.set(await this.assessment.verifyNotice(uuid));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  async serve(uuid: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.assessment.serveNotice(uuid, {
        channel: this.channel,
        addressee: this.addressee,
        proofReference: this.proofReference === '' ? undefined : this.proofReference,
      });
      this.addressee = '';
      this.proofReference = '';
      await this.load();
      this.changed.emit();
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.busy.set(false);
    }
  }

  async outcome(uuid: string, serviceId: number, status: string): Promise<void> {
    this.error.set(null);
    try {
      await this.assessment.recordServiceOutcome(uuid, serviceId, {
        status,
        failureReason:
          status === 'RETURNED' || status === 'FAILED'
            ? 'Recorded from the case workbench.'
            : undefined,
      });
      await this.load();
      this.changed.emit();
    } catch (error) {
      this.error.set(describeError(error));
    }
  }
}
