import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { InvalidTransitionError, UnauthorisedTransitionError } from '@tas/contracts';
import { CurrencyMismatchError, InvalidMoneyError } from '@tas/decimal';
import { currentCorrelationId } from '../auth/request-context';

/**
 * Maps shared-package domain errors to HTTP statuses.
 *
 * Plan reference: V2 section 14.5.
 *
 * ## Why this exists
 *
 * The domain throws typed errors that mean specific things: "that transition
 * is not permitted from this status", "your role may not do that", "those
 * amounts are in different currencies". Without a filter every one of them
 * surfaces as a 500, and a caller cannot tell a refusal from a server fault. A
 * client retrying a 500 that was really a 403 is a bug on both sides.
 *
 * ## Why only shared-package errors
 *
 * This file lives in `platform`, which must not import from `tax-assessment`
 * (plan 14.2, enforced by `import/no-restricted-paths`). `@tas/contracts` and
 * `@tas/decimal` are shared packages that the platform may depend on, so their
 * errors belong here. Errors owned by the assessment domain are mapped by
 * `CalculationExceptionFilter`, which lives inside that domain.
 *
 * ## The status choices
 *
 * `UnauthorisedTransitionError` is 403, not 401: the caller is authenticated,
 * they simply may not do this.
 *
 * `InvalidTransitionError` is 409, not 400: the request is well-formed and
 * conflicts with the case's current state. A client that refreshes and retries
 * may well succeed, which is exactly what 409 means.
 */
@Catch(
  InvalidTransitionError,
  UnauthorisedTransitionError,
  CurrencyMismatchError,
  InvalidMoneyError,
)
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();

    const { status, code } = classify(exception);
    const correlationId = currentCorrelationId();

    // Logged at warn, not error: a refused transition is the expected outcome
    // of a system with rules, not an incident.
    this.logger.warn(
      `${exception.name} [${correlationId ?? 'no-correlation'}]: ${exception.message}`,
    );

    response.status(status).json({
      statusCode: status,
      error: code,
      // The domain messages are written to be read by the person who hit them
      // and contain no taxpayer data, so they are safe to return.
      message: exception.message,
      correlationId,
    });
  }
}

function classify(exception: Error): { status: number; code: string } {
  if (exception instanceof UnauthorisedTransitionError) {
    return { status: HttpStatus.FORBIDDEN, code: 'TRANSITION_NOT_PERMITTED_FOR_ROLE' };
  }

  if (exception instanceof InvalidTransitionError) {
    return { status: HttpStatus.CONFLICT, code: 'TRANSITION_NOT_VALID_FROM_STATUS' };
  }

  if (exception instanceof CurrencyMismatchError) {
    return { status: HttpStatus.BAD_REQUEST, code: 'CURRENCY_MISMATCH' };
  }

  if (exception instanceof InvalidMoneyError) {
    return { status: HttpStatus.BAD_REQUEST, code: 'INVALID_AMOUNT' };
  }

  // Unreachable given @Catch, but a filter that silently returned 200 on an
  // unrecognised error would be worse than one that says 500.
  return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'UNEXPECTED' };
}
