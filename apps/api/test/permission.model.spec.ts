import {
  PermissionLevel,
  decide,
  permissionKeyFor,
  satisfies,
  type RolePermissionMap,
} from '../src/platform/authorization/permission.model';

/**
 * The authorisation decision is the security boundary, so it is tested
 * exhaustively and without infrastructure.
 *
 * The central property: there is no input to `decide` that grants access by
 * accident. Every test below either asserts a specific grant that should
 * happen, or asserts a denial for a reason that must deny.
 */

const ROUTE = 'GET /api/v1/cases';
const ADMIN_ROUTE = 'POST /api/v1/admin/permissions/refresh-cache';

function grants(
  entries: Record<string, Record<string, PermissionLevel>>,
): ReadonlyMap<string, RolePermissionMap> {
  return new Map(
    Object.entries(entries).map(([role, perms]) => [
      role,
      new Map(Object.entries(perms)) as RolePermissionMap,
    ]),
  );
}

const REGISTERED = new Set([ROUTE, ADMIN_ROUTE]);

describe('permissionKeyFor', () => {
  it('builds a key from method and declared path', () => {
    expect(permissionKeyFor('get', '/api/v1/cases')).toBe('GET /api/v1/cases');
  });

  it('upper-cases the method', () => {
    expect(permissionKeyFor('post', '/api/v1/cases')).toBe('POST /api/v1/cases');
  });

  it('normalises a missing leading slash', () => {
    expect(permissionKeyFor('GET', 'api/v1/cases')).toBe('GET /api/v1/cases');
  });

  it('keeps the parameterised form, not a concrete id', () => {
    // One catalogue row must cover the route, not one row per case.
    expect(permissionKeyFor('GET', '/api/v1/cases/:id')).toBe('GET /api/v1/cases/:id');
  });
});

describe('satisfies', () => {
  it('treats levels as hierarchical', () => {
    expect(satisfies(PermissionLevel.FULL, PermissionLevel.VIEW)).toBe(true);
    expect(satisfies(PermissionLevel.FULL, PermissionLevel.EDIT)).toBe(true);
    expect(satisfies(PermissionLevel.EDIT, PermissionLevel.VIEW)).toBe(true);
    expect(satisfies(PermissionLevel.VIEW, PermissionLevel.VIEW)).toBe(true);
  });

  it('does not let a lower grant satisfy a higher requirement', () => {
    expect(satisfies(PermissionLevel.VIEW, PermissionLevel.EDIT)).toBe(false);
    expect(satisfies(PermissionLevel.EDIT, PermissionLevel.FULL)).toBe(false);
  });
});

describe('decide - grants', () => {
  it('allows a role holding the exact required level', () => {
    const decision = decide(
      ROUTE,
      PermissionLevel.VIEW,
      ['TA_ASSESSOR'],
      grants({ TA_ASSESSOR: { [ROUTE]: PermissionLevel.VIEW } }),
      REGISTERED,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('GRANTED');
  });

  it('allows a role holding more than required', () => {
    const decision = decide(
      ROUTE,
      PermissionLevel.VIEW,
      ['TA_ADMIN'],
      grants({ TA_ADMIN: { [ROUTE]: PermissionLevel.FULL } }),
      REGISTERED,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.effectiveLevel).toBe(PermissionLevel.FULL);
  });

  it('takes the highest grant across several roles', () => {
    // A user holding both a read-only and an admin role gets the admin level.
    const decision = decide(
      ROUTE,
      PermissionLevel.EDIT,
      ['TA_AUDITOR_READONLY', 'TA_ADMIN'],
      grants({
        TA_AUDITOR_READONLY: { [ROUTE]: PermissionLevel.VIEW },
        TA_ADMIN: { [ROUTE]: PermissionLevel.FULL },
      }),
      REGISTERED,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.effectiveLevel).toBe(PermissionLevel.FULL);
  });
});

describe('decide - denials', () => {
  it('denies an unregistered route even to an administrator', () => {
    // Forgetting to register a route must make it unreachable, not open.
    const decision = decide(
      'DELETE /api/v1/everything',
      PermissionLevel.VIEW,
      ['TA_ADMIN'],
      grants({ TA_ADMIN: { 'DELETE /api/v1/everything': PermissionLevel.FULL } }),
      REGISTERED,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('ROUTE_NOT_REGISTERED');
  });

  it('denies a caller with no roles', () => {
    const decision = decide(ROUTE, PermissionLevel.VIEW, [], grants({}), REGISTERED);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('NO_ROLES');
  });

  it('denies a role with no grant on the route', () => {
    const decision = decide(
      ROUTE,
      PermissionLevel.VIEW,
      ['TA_TAXPAYER'],
      grants({ TA_ASSESSOR: { [ROUTE]: PermissionLevel.VIEW } }),
      REGISTERED,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('NOT_GRANTED');
  });

  it('denies a role whose grant is below the required level', () => {
    const decision = decide(
      ADMIN_ROUTE,
      PermissionLevel.FULL,
      ['TA_AUDITOR_READONLY'],
      grants({ TA_AUDITOR_READONLY: { [ADMIN_ROUTE]: PermissionLevel.VIEW } }),
      REGISTERED,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('INSUFFICIENT_LEVEL');
    expect(decision.effectiveLevel).toBe(PermissionLevel.VIEW);
  });

  it('denies an unknown role code', () => {
    // A role present in a token but absent from the catalogue authorises
    // nothing. A forged or stale token cannot invent access.
    const decision = decide(
      ROUTE,
      PermissionLevel.VIEW,
      ['TA_NOT_A_REAL_ROLE'],
      grants({ TA_ASSESSOR: { [ROUTE]: PermissionLevel.VIEW } }),
      REGISTERED,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('NOT_GRANTED');
  });

  it('denies when the catalogue is empty', () => {
    const decision = decide(ROUTE, PermissionLevel.VIEW, ['TA_ADMIN'], grants({}), REGISTERED);
    expect(decision.allowed).toBe(false);
  });

  it('denies every route when nothing is registered', () => {
    // The state immediately after a failed catalogue load: deny everything.
    for (const level of [PermissionLevel.VIEW, PermissionLevel.EDIT, PermissionLevel.FULL]) {
      const decision = decide(
        ROUTE,
        level,
        ['TA_ADMIN'],
        grants({ TA_ADMIN: { [ROUTE]: PermissionLevel.FULL } }),
        new Set(),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('ROUTE_NOT_REGISTERED');
    }
  });
});

describe('RBAC matrix', () => {
  // Mirrors the seeded catalogue. Extend this as routes are added: it is the
  // regression net for "did that permission change do what I intended".
  const CATALOGUE = grants({
    TA_ASSESSOR: { 'GET /api/v1/masters/:groupCode': PermissionLevel.VIEW },
    TA_AUDITOR_READONLY: {
      'GET /api/v1/masters': PermissionLevel.VIEW,
      'GET /api/v1/admin/permissions': PermissionLevel.VIEW,
    },
    TA_ADMIN: {
      'GET /api/v1/masters': PermissionLevel.FULL,
      'POST /api/v1/masters': PermissionLevel.FULL,
      'GET /api/v1/admin/permissions': PermissionLevel.FULL,
      'POST /api/v1/admin/permissions/refresh-cache': PermissionLevel.FULL,
    },
  });

  const ROUTES = new Set([
    'GET /api/v1/masters',
    'GET /api/v1/masters/:groupCode',
    'POST /api/v1/masters',
    'GET /api/v1/admin/permissions',
    'POST /api/v1/admin/permissions/refresh-cache',
  ]);

  const matrix: Array<[string, string, PermissionLevel, boolean]> = [
    // role, route, required, expected
    ['TA_ADMIN', 'POST /api/v1/masters', PermissionLevel.EDIT, true],
    ['TA_ADMIN', 'POST /api/v1/admin/permissions/refresh-cache', PermissionLevel.FULL, true],
    ['TA_AUDITOR_READONLY', 'GET /api/v1/admin/permissions', PermissionLevel.VIEW, true],
    // An auditor is read-only: no write anywhere, ever.
    ['TA_AUDITOR_READONLY', 'POST /api/v1/masters', PermissionLevel.EDIT, false],
    [
      'TA_AUDITOR_READONLY',
      'POST /api/v1/admin/permissions/refresh-cache',
      PermissionLevel.FULL,
      false,
    ],
    // An assessor may read reference data but not administer it.
    ['TA_ASSESSOR', 'GET /api/v1/masters/:groupCode', PermissionLevel.VIEW, true],
    ['TA_ASSESSOR', 'POST /api/v1/masters', PermissionLevel.EDIT, false],
    ['TA_ASSESSOR', 'GET /api/v1/admin/permissions', PermissionLevel.VIEW, false],
    // A taxpayer reaches none of this.
    ['TA_TAXPAYER', 'GET /api/v1/masters', PermissionLevel.VIEW, false],
    ['TA_TAXPAYER', 'POST /api/v1/masters', PermissionLevel.EDIT, false],
  ];

  it.each(matrix)('%s on %s (needs %s) -> %s', (role, route, required, expected) => {
    expect(decide(route, required, [role], CATALOGUE, ROUTES).allowed).toBe(expected);
  });

  it('never lets a read-only role write anything in the catalogue', () => {
    // A property over the whole catalogue rather than a list of cases: if a
    // future migration grants the auditor a write, this fails.
    const writeRoutes = [...ROUTES].filter((route) => !route.startsWith('GET '));
    for (const route of writeRoutes) {
      const decision = decide(
        route,
        PermissionLevel.EDIT,
        ['TA_AUDITOR_READONLY'],
        CATALOGUE,
        ROUTES,
      );
      expect(decision.allowed).toBe(false);
    }
  });
});
