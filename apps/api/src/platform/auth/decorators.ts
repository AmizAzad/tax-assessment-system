import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { PermissionLevel } from '../authorization/permission.model';
import type { RequestContext } from './request-context';

export const PUBLIC_KEY = 'tas:public';
export const PERMISSION_LEVEL_KEY = 'tas:permissionLevel';

/**
 * Marks a route as reachable without authentication.
 *
 * Use sparingly. The only intended public routes are health probes and notice
 * verification, and verification returns status only -- never financial detail
 * (plan section 20). Every addition here widens the unauthenticated attack
 * surface and should be reviewed as a security change.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

/**
 * The permission level this route demands.
 *
 * The permission *key* is derived from the method and path, so it cannot drift
 * from the route it protects. Only the level is declared here.
 *
 * Omitting this decorator does not make a route public: the guard defaults to
 * VIEW and the route must still be registered in the catalogue.
 */
export const RequirePermission = (
  level: PermissionLevel = PermissionLevel.VIEW,
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSION_LEVEL_KEY, level);

/**
 * Injects the authenticated caller.
 *
 * Prefer this over reaching into the AsyncLocalStorage store in a controller:
 * an explicit parameter is visible in the signature and trivial to supply in a
 * test.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext | undefined => {
    const request = ctx.switchToHttp().getRequest<{ tasContext?: RequestContext }>();
    return request.tasContext;
  },
);
