import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { currentCorrelationId } from '../../platform/auth/request-context';
import { CalculationError } from './types';

/**
 * Maps calculation errors to HTTP statuses.
 *
 * Plan reference: V2 section 14.5.
 *
 * ## Why this is separate from DomainExceptionFilter
 *
 * `CalculationError` is owned by the assessment domain, and the platform must
 * not import from it (plan 14.2). Putting this mapping in the platform filter
 * would invert the dependency the boundary rule exists to protect, so the
 * domain maps its own errors and registers this filter itself.
 *
 * ## The status split
 *
 * A missing or ambiguous rule set is 409: the request is fine, the
 * configuration conflicts, and an administrator has to resolve it. Retrying
 * unchanged will not help, but the caller is not at fault either.
 *
 * A bad parameter or a currency mismatch is 400: the calculation cannot be
 * satisfied as asked.
 */
@Catch(CalculationError)
export class CalculationExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(CalculationExceptionFilter.name);

  catch(exception: CalculationError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (code: number) => { json: (body: unknown) => void };
    }>();

    const conflicting =
      exception.reason === 'NO_EFFECTIVE_RULE' || exception.reason === 'AMBIGUOUS_RULE';
    const status = conflicting ? HttpStatus.CONFLICT : HttpStatus.BAD_REQUEST;
    const correlationId = currentCorrelationId();

    // A calculation that could not run is worth more than a warning: it means
    // a case cannot be progressed until somebody changes configuration.
    this.logger.error(
      `CalculationError at ${exception.step} [${correlationId ?? 'no-correlation'}]: ` +
        exception.message,
    );

    response.status(status).json({
      statusCode: status,
      error: `CALCULATION_${exception.reason}`,
      message: exception.message,
      // Which step failed is the first thing anybody investigating needs, and
      // it names a step in the same trace the caseworker is looking at.
      step: exception.step,
      correlationId,
    });
  }
}
