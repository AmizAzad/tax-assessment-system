import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { QueryTypes, type Sequelize } from 'sequelize';
import { SEQUELIZE } from '../../infrastructure/tokens';
import type { RequestContext } from '../auth/request-context';
import { redact } from './redaction';

/**
 * Records API access for audit.
 *
 * Plan reference: V2 sections 6.5, 19.1, 20.
 *
 * Answers "who called what, when, and did it succeed" — a question an auditor
 * asks about privileged access to taxpayer data.
 *
 * ## What it deliberately does not record
 *
 * Request and response bodies never go in whole. The request is summarised
 * through the redaction allowlist (`redaction.ts`), and the response is not
 * captured at all: a successful `GET /cases/:id` response *is* the taxpayer's
 * financial position, and copying it into a second table with different access
 * controls would defeat the controls on the first.
 *
 * ## Failures here never fail the request
 *
 * An audit write that could break a business operation would be a worse
 * outcome than a missing trace row. Failures are logged and dropped; a
 * persistent problem shows up as a gap plus a stream of log lines.
 */
@Injectable()
export class ApiTraceInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ApiTraceInterceptor.name);

  /** Paths never traced: high-volume, low-value, and probed constantly. */
  private readonly excluded = [/^\/health/, /^\/api\/docs/, /^\/metrics/];

  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method: string;
      url: string;
      route?: { path?: string };
      headers: Record<string, string | string[] | undefined>;
      body?: unknown;
      query?: unknown;
      ip?: string;
      tasContext?: RequestContext;
    }>();

    const path = request.route?.path ?? request.url.split('?')[0] ?? request.url;
    if (this.excluded.some((pattern) => pattern.test(path))) {
      return next.handle();
    }

    const startedAt = Date.now();

    const record = (statusCode: number): void => {
      const caller = request.tasContext;
      void this.write({
        correlationId: caller?.correlationId ?? 'unknown',
        method: request.method,
        path,
        statusCode,
        actorUserId: caller?.userId,
        actorRoles: caller?.roleCodes,
        durationMs: Date.now() - startedAt,
        requestSummary: {
          query: redact(request.query),
          body: redact(request.body),
        },
        ipAddress: request.ip,
      });
    };

    return next.handle().pipe(
      tap({
        next: () => record(http.getResponse<{ statusCode?: number }>().statusCode ?? 200),
        // A rejected request is the more interesting audit event, not less:
        // repeated 403s are what an intrusion attempt looks like.
        error: (error: { status?: number }) => record(error?.status ?? 500),
      }),
    );
  }

  private async write(entry: {
    correlationId: string;
    method: string;
    path: string;
    statusCode: number;
    actorUserId?: number;
    actorRoles?: readonly string[];
    durationMs: number;
    requestSummary: unknown;
    ipAddress?: string;
  }): Promise<void> {
    try {
      await this.sequelize.query(
        `INSERT INTO platform.api_trace_log
                (correlation_id, method, path, status_code, actor_user_id, actor_roles,
                 duration_ms, request_summary, ip_address)
         VALUES (:correlationId, :method, :path, :statusCode, :actorUserId,
                 CAST(:actorRoles AS jsonb), :durationMs,
                 CAST(:requestSummary AS jsonb), :ipAddress)`,
        {
          type: QueryTypes.INSERT,
          replacements: {
            correlationId: entry.correlationId,
            method: entry.method,
            path: entry.path,
            statusCode: entry.statusCode,
            actorUserId: entry.actorUserId ?? null,
            actorRoles: JSON.stringify(entry.actorRoles ?? []),
            durationMs: entry.durationMs,
            requestSummary: JSON.stringify(entry.requestSummary),
            ipAddress: entry.ipAddress ?? null,
          },
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to write an API trace for ${entry.method} ${entry.path}: ` +
          `${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
