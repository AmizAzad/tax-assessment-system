import {
  AuthorizationCacheUnavailableError,
  PermissionCacheService,
} from '../src/platform/authorization/permission-cache.service';
import { PermissionLevel, decide } from '../src/platform/authorization/permission.model';

/**
 * Fail-closed behaviour of the authorisation catalogue.
 *
 * Plan reference: V2 sections 6.1, 20, 28 R18.
 *
 * This is the most important test in the auth layer. If the catalogue cannot
 * be loaded, every request must be denied. The failure mode being guarded
 * against is a Redis outage quietly opening every route in a tax system --
 * denial is disruptive and obvious, granting is silent and catastrophic.
 */

type QueryResult = Array<Record<string, unknown>>;

function fakeSequelize(grantRows: QueryResult, routeRows: QueryResult, failing = false) {
  return {
    query: jest.fn(async (sql: string) => {
      if (failing) throw new Error('database unreachable');
      return sql.includes('role_permission') ? grantRows : routeRows;
    }),
  } as never;
}

function fakeRedis(options: {
  getImpl?: () => Promise<string | null>;
  setImpl?: () => Promise<'OK'>;
}) {
  const store = { value: null as string | null };
  return {
    store,
    client: {
      get: jest.fn(options.getImpl ?? (async () => store.value)),
      set: jest.fn(
        options.setImpl ??
          (async (_key: string, value: string) => {
            store.value = value;
            return 'OK' as const;
          }),
      ),
    } as never,
  };
}

const GRANT_ROWS: QueryResult = [
  { role_code: 'TA_ADMIN', permission_key: 'GET /api/v1/cases', granted_level: 30 },
  { role_code: 'TA_ASSESSOR', permission_key: 'GET /api/v1/cases', granted_level: 10 },
];
const ROUTE_ROWS: QueryResult = [{ permission_key: 'GET /api/v1/cases' }];

describe('PermissionCacheService - normal operation', () => {
  it('builds the catalogue from the database and publishes it', async () => {
    const redis = fakeRedis({});
    const service = new PermissionCacheService(fakeSequelize(GRANT_ROWS, ROUTE_ROWS), redis.client);

    const result = await service.refresh();

    expect(result).toEqual({ roles: 2, routes: 1 });
    expect(redis.store.value).not.toBeNull();
  });

  it('serves grants and routes after a refresh', async () => {
    const redis = fakeRedis({});
    const service = new PermissionCacheService(fakeSequelize(GRANT_ROWS, ROUTE_ROWS), redis.client);

    await service.refresh();
    const { grants, routes } = await service.get();

    expect(routes.has('GET /api/v1/cases')).toBe(true);
    expect(grants.get('TA_ADMIN')?.get('GET /api/v1/cases')).toBe(30);
    expect(grants.get('TA_ASSESSOR')?.get('GET /api/v1/cases')).toBe(10);
  });

  it('rebuilds automatically when the cache has expired', async () => {
    const redis = fakeRedis({});
    const sequelize = fakeSequelize(GRANT_ROWS, ROUTE_ROWS);
    const service = new PermissionCacheService(sequelize, redis.client);

    await service.refresh();
    // Simulate eviction: key gone, process-local copy dropped.
    redis.store.value = null;
    service.invalidateLocal();

    const { routes } = await service.get();
    expect(routes.has('GET /api/v1/cases')).toBe(true);
  });
});

describe('PermissionCacheService - fails closed', () => {
  it('throws when Redis read fails', async () => {
    const service = new PermissionCacheService(
      fakeSequelize(GRANT_ROWS, ROUTE_ROWS),
      fakeRedis({
        getImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }).client,
    );

    await expect(service.get()).rejects.toBeInstanceOf(AuthorizationCacheUnavailableError);
  });

  it('throws when the cache is empty and the database is also unreachable', async () => {
    const service = new PermissionCacheService(
      fakeSequelize([], [], true),
      fakeRedis({ getImpl: async () => null }).client,
    );

    await expect(service.get()).rejects.toBeInstanceOf(AuthorizationCacheUnavailableError);
  });

  it('throws when the cached catalogue is corrupt', async () => {
    // A truncated or tampered value must not be parsed into a permissive
    // default. Reject it.
    const redis = fakeRedis({ getImpl: async () => '{not valid json' });
    const service = new PermissionCacheService(fakeSequelize(GRANT_ROWS, ROUTE_ROWS), redis.client);

    await expect(service.get()).rejects.toBeInstanceOf(AuthorizationCacheUnavailableError);
  });

  it('does not serve a stale local copy once it has expired', async () => {
    // The process-local copy absorbs Redis latency; it is not an outage
    // fallback. Once expired with Redis down, the service must deny rather
    // than keep running on a catalogue whose source of truth has gone.
    jest.useFakeTimers();
    try {
      let redisUp = true;
      const redis = fakeRedis({
        getImpl: async () => {
          if (!redisUp) throw new Error('ECONNREFUSED');
          return redis.store.value;
        },
      });
      const service = new PermissionCacheService(
        fakeSequelize(GRANT_ROWS, ROUTE_ROWS),
        redis.client,
      );

      await service.refresh();
      await expect(service.get()).resolves.toBeDefined();

      redisUp = false;
      // Still inside the local TTL: served from the process-local copy.
      await expect(service.get()).resolves.toBeDefined();

      // Past the TTL with Redis still down: deny.
      jest.advanceTimersByTime(301_000);
      await expect(service.get()).rejects.toBeInstanceOf(AuthorizationCacheUnavailableError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('denies every route when the catalogue cannot be loaded', async () => {
    // The end-to-end consequence: the guard turns the thrown error into a
    // denial, so no route is reachable.
    const service = new PermissionCacheService(
      fakeSequelize(GRANT_ROWS, ROUTE_ROWS),
      fakeRedis({
        getImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }).client,
    );

    let denied = false;
    try {
      await service.get();
    } catch {
      denied = true;
    }
    expect(denied).toBe(true);

    // And with an empty catalogue, the decision function itself denies.
    expect(
      decide('GET /api/v1/cases', PermissionLevel.VIEW, ['TA_ADMIN'], new Map(), new Set()).allowed,
    ).toBe(false);
  });
});
