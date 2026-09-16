/**
 * The authorisation decision model.
 *
 * Plan reference: V2 sections 6.1, 9.
 *
 * This file is deliberately pure: no database, no Redis, no Nest. The decision
 * logic is the security boundary, so it is the part that must be exhaustively
 * testable without infrastructure. Everything that touches I/O lives in
 * `permission-cache.service.ts` and hands its results in here.
 */

/** 10 VIEW, 20 EDIT, 30 FULL. Hierarchical: a higher grant satisfies a lower requirement. */
export enum PermissionLevel {
  VIEW = 10,
  EDIT = 20,
  FULL = 30,
}

/** One row of the permission catalogue, as cached. */
export interface PermissionGrant {
  readonly permissionKey: string;
  readonly grantedLevel: PermissionLevel;
}

/** Everything a role is permitted to do, keyed by route. */
export type RolePermissionMap = ReadonlyMap<string, PermissionLevel>;

export interface AuthorizationDecision {
  readonly allowed: boolean;
  /** Machine-readable reason. Surfaced in logs, never to the caller verbatim. */
  readonly reason:
    | 'GRANTED'
    | 'NO_ROLES'
    | 'ROUTE_NOT_REGISTERED'
    | 'INSUFFICIENT_LEVEL'
    | 'NOT_GRANTED'
    | 'CACHE_UNAVAILABLE';
  readonly permissionKey: string;
  readonly effectiveLevel?: PermissionLevel;
}

/**
 * The permission key for a route.
 *
 * Path parameters are normalised to their declared form (`/cases/:id`, not
 * `/cases/42`) so that one catalogue row covers a route rather than one per
 * resource instance.
 */
export function permissionKeyFor(method: string, routePath: string): string {
  const normalisedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${method.toUpperCase()} ${normalisedPath}`;
}

/**
 * Decide whether a caller may invoke a route.
 *
 * Fails closed at every branch: an unknown route, an unknown role, a caller
 * with no roles, and an unavailable cache all deny. There is no path through
 * this function that grants access by default.
 *
 * @param permissionKey the route being invoked
 * @param requiredLevel the level the route demands
 * @param callerRoles the caller's role codes
 * @param grantsByRole permitted routes per role, from the cache
 * @param registeredRoutes every route in the catalogue; a route absent from
 *        this set is unreachable, which is what makes forgetting to register
 *        a route a visible failure rather than an open door
 */
export function decide(
  permissionKey: string,
  requiredLevel: PermissionLevel,
  callerRoles: readonly string[],
  grantsByRole: ReadonlyMap<string, RolePermissionMap>,
  registeredRoutes: ReadonlySet<string>,
): AuthorizationDecision {
  if (!registeredRoutes.has(permissionKey)) {
    // An unregistered route is a bug, and the safe response to a bug in the
    // authorisation path is to deny. Plan section 20.
    return { allowed: false, reason: 'ROUTE_NOT_REGISTERED', permissionKey };
  }

  if (callerRoles.length === 0) {
    return { allowed: false, reason: 'NO_ROLES', permissionKey };
  }

  let best: PermissionLevel | undefined;
  for (const roleCode of callerRoles) {
    const granted = grantsByRole.get(roleCode)?.get(permissionKey);
    if (granted !== undefined && (best === undefined || granted > best)) {
      best = granted;
    }
  }

  if (best === undefined) {
    return { allowed: false, reason: 'NOT_GRANTED', permissionKey };
  }

  if (best < requiredLevel) {
    return {
      allowed: false,
      reason: 'INSUFFICIENT_LEVEL',
      permissionKey,
      effectiveLevel: best,
    };
  }

  return { allowed: true, reason: 'GRANTED', permissionKey, effectiveLevel: best };
}

/** A higher grant satisfies a lower requirement. */
export function satisfies(granted: PermissionLevel, required: PermissionLevel): boolean {
  return granted >= required;
}
