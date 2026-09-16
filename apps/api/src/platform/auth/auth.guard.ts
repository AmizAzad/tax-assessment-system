import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config/configuration';
import { APP_CONFIG } from '../../infrastructure/tokens';
import { PermissionCacheService } from '../authorization/permission-cache.service';
import { PermissionLevel, decide, permissionKeyFor } from '../authorization/permission.model';
import { PERMISSION_LEVEL_KEY, PUBLIC_KEY } from './decorators';
import { runWithContext, type RequestContext } from './request-context';
import { TokenVerifierService } from './token-verifier.service';
import { UserDirectoryService } from './user-directory.service';

interface IncomingRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  url: string;
  tasContext?: RequestContext;
}

/**
 * Authentication and authorisation, applied globally.
 *
 * Plan reference: V2 sections 6.1, 20; ADR-003.
 *
 * Registered as a global guard, so a new route is protected by default and
 * must opt out explicitly with `@Public()`. The inverse -- opting in per route
 * -- means the first forgotten decorator is an open endpoint, which is the
 * wrong default for a tax system.
 *
 * Every failure path denies. There is no branch here that grants on error.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokenVerifier: TokenVerifierService,
    private readonly permissionCache: PermissionCacheService,
    private readonly userDirectory: UserDirectoryService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IncomingRequest>();
    const correlationId = headerValue(request, 'x-correlation-id') ?? randomUUID();

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic === true) {
      const anonymous: RequestContext = {
        roleCodes: [],
        correlationId,
        jurisdictionCode: this.config.defaultJurisdiction,
        requestedAt: new Date(),
      };
      request.tasContext = anonymous;
      return runWithContext(anonymous, () => true);
    }

    // ---------------------------------------------------------- authenticate
    const token = bearerToken(request);
    if (token === undefined) {
      throw new UnauthorizedException('Authentication required');
    }

    let verified;
    try {
      verified = await this.tokenVerifier.verify(token);
    } catch (error) {
      // The reason goes to the log, not to the caller: telling an attacker
      // whether a token expired or was forged is free information.
      this.logger.warn(`Token verification failed [${correlationId}]: ${describe(error)}`);
      throw new UnauthorizedException('Authentication required');
    }

    // Mirror the IdP subject into the local directory so audit rows can
    // reference a stable local user id.
    const user = await this.userDirectory.resolve(verified);

    const callerContext: RequestContext = {
      userId: user.id,
      subject: verified.subject,
      username: verified.username,
      roleCodes: verified.roleCodes,
      correlationId,
      jurisdictionCode: headerValue(request, 'x-jurisdiction') ?? this.config.defaultJurisdiction,
      requestedAt: new Date(),
    };

    // ----------------------------------------------------------- authorise
    const requiredLevel =
      this.reflector.getAllAndOverride<PermissionLevel>(PERMISSION_LEVEL_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? PermissionLevel.VIEW;

    const permissionKey = permissionKeyFor(request.method, routePathOf(request));

    let catalogue;
    try {
      catalogue = await this.permissionCache.get();
    } catch (error) {
      // Fail closed. A cache outage must not open every route (plan 28 R18).
      this.logger.error(
        `Authorization catalogue unavailable [${correlationId}]: ${describe(error)}. Denying.`,
      );
      throw new ForbiddenException('Authorization is temporarily unavailable');
    }

    const decision = decide(
      permissionKey,
      requiredLevel,
      verified.roleCodes,
      catalogue.grants,
      catalogue.routes,
    );

    if (!decision.allowed) {
      this.logger.warn(
        `Denied ${permissionKey} for ${verified.username} [${correlationId}]: ${decision.reason}`,
      );
      if (decision.reason === 'ROUTE_NOT_REGISTERED') {
        // A developer error, not a caller error. Loud, because the route is
        // unreachable until someone adds the catalogue row.
        this.logger.error(
          `Route ${permissionKey} is not in the permission catalogue. ` +
            `Register it in a migration; until then it is unreachable.`,
        );
      }
      throw new ForbiddenException('Insufficient permissions');
    }

    request.tasContext = callerContext;
    return runWithContext(callerContext, () => true);
  }
}

function headerValue(request: IncomingRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function bearerToken(request: IncomingRequest): string | undefined {
  const header = headerValue(request, 'authorization');
  if (header === undefined) return undefined;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}

/**
 * The declared route path, not the concrete URL.
 *
 * `/api/v1/cases/:id` rather than `/api/v1/cases/42`, so one catalogue row
 * covers the route rather than one per resource instance.
 */
function routePathOf(request: IncomingRequest): string {
  return request.route?.path ?? request.url.split('?')[0] ?? request.url;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
