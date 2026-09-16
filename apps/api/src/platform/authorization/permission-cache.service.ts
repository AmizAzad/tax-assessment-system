import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { QueryTypes, type Sequelize } from 'sequelize';
import { REDIS_CLIENT, SEQUELIZE } from '../../infrastructure/tokens';
import { PermissionLevel, type RolePermissionMap } from './permission.model';

const CACHE_KEY = 'tas:authz:v1';
const CACHE_TTL_SECONDS = 300;

interface CachedCatalogue {
  readonly version: string;
  /** roleCode -> { permissionKey: grantedLevel } */
  readonly grants: Record<string, Record<string, number>>;
  /** Every registered route. A route absent from here is unreachable. */
  readonly routes: string[];
}

export class AuthorizationCacheUnavailableError extends Error {
  constructor(cause: string) {
    super(`Authorization catalogue is unavailable: ${cause}`);
    this.name = 'AuthorizationCacheUnavailableError';
  }
}

/**
 * The permission catalogue, cached in Redis.
 *
 * Plan reference: V2 sections 6.1, 28 R18.
 *
 * ## Why this fails closed
 *
 * If the catalogue cannot be loaded, every request is denied. The alternative
 * -- falling back to "allow" or to a stale permissive default -- would mean a
 * Redis outage silently opens every route in a tax system. Denying is
 * disruptive and obvious; granting is quiet and catastrophic.
 *
 * Readiness reports Redis as a hard dependency for the same reason: an
 * instance that cannot authorise anyone should leave the load balancer rather
 * than return 403 to every caller.
 *
 * ## Why there is a process-local copy
 *
 * A short-lived in-process copy absorbs Redis latency on the hot path. It is
 * NOT a fallback for an outage: it carries the same TTL, and once it expires
 * with Redis still unreachable, the service denies. A fallback that outlived
 * the outage would be an authorisation cache that keeps working after the
 * source of truth has gone, which is exactly the failure we are avoiding.
 */
@Injectable()
export class PermissionCacheService implements OnModuleInit {
  private readonly logger = new Logger(PermissionCacheService.name);

  private local: {
    grants: Map<string, RolePermissionMap>;
    routes: Set<string>;
    expiresAt: number;
  } | null = null;

  constructor(
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    // Warm on boot so the first authenticated request does not pay for the
    // database read. A failure here is logged, not fatal: the instance can
    // still serve health checks while an operator investigates.
    try {
      await this.refresh();
    } catch (error) {
      this.logger.error(
        `Failed to warm the authorization catalogue on boot: ${describe(error)}. ` +
          `Requests will be denied until it loads.`,
      );
    }
  }

  /**
   * Rebuild the catalogue from the database and publish it to Redis.
   *
   * Called on boot, after a migration that changes permissions, and from the
   * admin refresh endpoint.
   */
  async refresh(): Promise<{ roles: number; routes: number }> {
    const rows = await this.sequelize.query<{
      role_code: string;
      permission_key: string;
      granted_level: number;
    }>(
      `SELECT r.role_code, p.permission_key, rp.granted_level
         FROM platform.role_permission rp
         JOIN platform.role r       ON r.id = rp.role_id
         JOIN platform.permission p ON p.id = rp.permission_id
        WHERE rp.is_active AND r.is_active AND p.is_active`,
      { type: QueryTypes.SELECT },
    );

    const routeRows = await this.sequelize.query<{ permission_key: string }>(
      `SELECT permission_key FROM platform.permission WHERE is_active`,
      { type: QueryTypes.SELECT },
    );

    const grants: Record<string, Record<string, number>> = {};
    for (const row of rows) {
      (grants[row.role_code] ??= {})[row.permission_key] = row.granted_level;
    }

    const catalogue: CachedCatalogue = {
      version: new Date().toISOString(),
      grants,
      routes: routeRows.map((r) => r.permission_key),
    };

    await this.redis.set(CACHE_KEY, JSON.stringify(catalogue), 'EX', CACHE_TTL_SECONDS);
    this.local = null;

    this.logger.log(
      `Authorization catalogue refreshed: ${Object.keys(grants).length} roles, ` +
        `${catalogue.routes.length} routes`,
    );
    return { roles: Object.keys(grants).length, routes: catalogue.routes.length };
  }

  /**
   * The catalogue, for an authorisation decision.
   *
   * @throws AuthorizationCacheUnavailableError when it cannot be loaded. The
   *         caller must translate that into a denial, never into a grant.
   */
  async get(): Promise<{ grants: Map<string, RolePermissionMap>; routes: Set<string> }> {
    const now = Date.now();
    if (this.local !== null && this.local.expiresAt > now) {
      return { grants: this.local.grants, routes: this.local.routes };
    }

    let raw: string | null;
    try {
      raw = await this.redis.get(CACHE_KEY);
    } catch (error) {
      throw new AuthorizationCacheUnavailableError(`Redis read failed: ${describe(error)}`);
    }

    if (raw === null) {
      // Expired or evicted. Rebuild from the database; if that also fails the
      // error propagates and the request is denied.
      try {
        await this.refresh();
        raw = await this.redis.get(CACHE_KEY);
      } catch (error) {
        throw new AuthorizationCacheUnavailableError(`Rebuild failed: ${describe(error)}`);
      }
      if (raw === null) {
        throw new AuthorizationCacheUnavailableError('Catalogue absent after rebuild');
      }
    }

    let parsed: CachedCatalogue;
    try {
      parsed = JSON.parse(raw) as CachedCatalogue;
    } catch (error) {
      throw new AuthorizationCacheUnavailableError(`Catalogue is corrupt: ${describe(error)}`);
    }

    const grants = new Map<string, RolePermissionMap>();
    for (const [roleCode, permissions] of Object.entries(parsed.grants)) {
      const perRole = new Map<string, PermissionLevel>();
      for (const [key, level] of Object.entries(permissions)) {
        perRole.set(key, level as PermissionLevel);
      }
      grants.set(roleCode, perRole);
    }
    const routes = new Set(parsed.routes);

    this.local = { grants, routes, expiresAt: now + CACHE_TTL_SECONDS * 1000 };
    return { grants, routes };
  }

  /** Drop the process-local copy. Used by tests and after a refresh elsewhere. */
  invalidateLocal(): void {
    this.local = null;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
