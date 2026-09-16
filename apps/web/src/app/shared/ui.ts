import { ChangeDetectionStrategy, Component, Input, Pipe, PipeTransform } from '@angular/core';
import { formatAmount, humanise, isNegativeAmount, statusTone } from '../core/domain';

/**
 * Small display pieces shared by every assessment screen.
 *
 * Plan reference: V2 sections 18.2, 18.3.
 *
 * Kept in one file because each is a handful of lines and splitting them into
 * separate modules would cost more to navigate than it saves.
 */

/**
 * Groups the digits of a decimal string.
 *
 * A pipe rather than a helper call in each template so that the rule -- string
 * in, string out, no rounding, no `Number()` -- is applied in exactly one
 * place. See `formatAmount` for why that matters (ADR-007).
 */
@Pipe({ name: 'tasAmount', standalone: true })
export class AmountPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return formatAmount(value);
  }
}

/** `IN_PREPARATION` becomes `In preparation`. */
@Pipe({ name: 'tasHumanise', standalone: true })
export class HumanisePipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return humanise(value);
  }
}

/**
 * A status, coloured by what it means to the reader.
 *
 * The raw code is kept in the `title`, because an officer raising a support
 * ticket needs the code and a caseworker reading a register does not.
 */
@Component({
  selector: 'tas-status',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HumanisePipe],
  template: `<span class="tas-badge" [class]="'tas-badge tas-badge--' + tone" [title]="status">{{
    status | tasHumanise
  }}</span>`,
})
export class StatusBadge {
  @Input({ required: true }) status = '';

  get tone(): string {
    return statusTone(this.status);
  }
}

/**
 * An amount, right-aligned and coloured when negative.
 *
 * A refund and a demand look identical at a glance otherwise, and they are the
 * two figures it is most costly to confuse.
 */
@Component({
  selector: 'tas-money',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AmountPipe],
  template: `<span class="tas-amount" [class.tas-amount--negative]="negative"
    >{{ value | tasAmount }}{{ currency ? ' ' + currency : '' }}</span
  >`,
})
export class MoneyView {
  @Input() value: string | null | undefined;
  @Input() currency?: string;

  get negative(): boolean {
    return isNegativeAmount(this.value);
  }
}

/** Shown where a list is legitimately empty, so a blank panel is never ambiguous. */
@Component({
  selector: 'tas-empty',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="tas-empty"><ng-content></ng-content></div>`,
})
export class EmptyState {}

/**
 * An error surfaced from the API.
 *
 * The server's message is shown verbatim. Those messages are written to be
 * read by the person who hit them -- they say which roles may act, which
 * actions are permitted from here, what a template is missing -- and replacing
 * them with "something went wrong" would throw away the most useful thing the
 * API returns.
 */
@Component({
  selector: 'tas-error',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (message) {
      <div class="tas-alert tas-alert--danger" role="alert">
        {{ message }}
        @if (correlationId) {
          <p class="tas-alert__hint">Reference {{ correlationId }}</p>
        }
      </div>
    }
  `,
})
export class ErrorAlert {
  @Input() message: string | null = null;
  @Input() correlationId: string | null = null;
}

/**
 * Pull a readable message out of whatever the HTTP layer threw.
 *
 * Angular wraps the body in `error`, and the API puts its own message there.
 * Without this every failure reads "Http failure response for ...", which
 * tells the user nothing they can act on.
 */
export function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const body = (error as { error?: unknown }).error;
    if (typeof body === 'object' && body !== null) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      if (Array.isArray(message)) return message.join('; ');
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'The request failed.';
}

/** The correlation id the API returns on a refusal, for support. */
export function correlationOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null) {
    const body = (error as { error?: { correlationId?: unknown } }).error;
    const id = body?.correlationId;
    if (typeof id === 'string') return id;
  }
  return null;
}
