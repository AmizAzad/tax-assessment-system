import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../infrastructure/tokens';

/**
 * Authenticates the BPMN engine on the webhook endpoint.
 *
 * Plan reference: V2 sections 5.1, 20.
 *
 * The engine is a service, not a user: it holds no user token and there is no
 * person to authorise. So the webhook route is `@Public()` as far as the user
 * guard is concerned, and this guard is what actually protects it.
 *
 * Without it the only control is network placement, which is a deployment
 * assumption rather than a control the code enforces. Anyone who could reach
 * the endpoint could inject workflow events and corrupt the read model.
 *
 * ## Refusing to start rather than failing open
 *
 * If no token is configured outside development, the guard rejects every
 * request. A misconfigured deployment that silently accepted unauthenticated
 * engine events would be worse than one whose webhooks visibly fail.
 */
@Injectable()
export class EngineTokenGuard implements CanActivate {
  private readonly logger = new Logger(EngineTokenGuard.name);
  private readonly expected: string;
  private readonly isDevelopment: boolean;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.expected = config.bpmnServiceToken;
    this.isDevelopment = config.env === 'development' || config.env === 'test';

    if (this.expected === '' && !this.isDevelopment) {
      this.logger.error(
        'BPMN_SERVICE_TOKEN is not set. Every workflow event will be rejected. ' +
          'Set it on both the API and the engine.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();

    if (this.expected === '') {
      if (this.isDevelopment) {
        // Local development runs the engine without a credential. Noisy on
        // purpose: this must never be the situation in a deployed environment.
        this.logger.warn(
          'Accepting an unauthenticated workflow event because BPMN_SERVICE_TOKEN is unset ' +
            'and NODE_ENV is development. Do not run this way outside local development.',
        );
        return true;
      }
      throw new UnauthorizedException('Workflow events are not accepted');
    }

    const presented = bearerToken(request.headers['authorization']);
    if (presented === undefined || !constantTimeEquals(presented, this.expected)) {
      this.logger.warn('Rejected a workflow event with a missing or invalid service token');
      throw new UnauthorizedException('Workflow events are not accepted');
    }

    return true;
  }
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const [scheme, value] = raw.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value === '') {
    return undefined;
  }
  return value;
}

/** Compared in constant time so a wrong token cannot be found byte by byte. */
function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    // timingSafeEqual throws on a length mismatch, and the length is not the
    // secret, so comparing it directly is fine.
    return false;
  }
  return timingSafeEqual(a, b);
}
