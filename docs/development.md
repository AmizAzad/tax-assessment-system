# Development guide

---

## Prerequisites

| Tool              | Version | Notes                                                        |
| ----------------- | ------- | ------------------------------------------------------------ |
| Node.js           | 22 LTS  | `.nvmrc` pins the major                                      |
| npm               | 10+     | Workspaces                                                   |
| Docker            | 24+     | Local infrastructure                                         |
| Java              | **17+** | Only for `apps/bpmn-engine`. Everything else runs without it |
| PostgreSQL client | any     | Optional; `psql` via `docker exec` works                     |

> Java 17 is sufficient: Flowable 7 and Spring Boot 3.4 both require only 17 (ADR-002 amendment). The rest of the stack runs without Java at all.

---

## First run

```bash
npm install
cp .env.example .env

npm run dev:up          # Postgres, Redis, Keycloak, MinIO, Mailpit
npm run db:migrate      # schema, permissions, rule sets, form templates
npm run verify          # format:check + lint + typecheck + test

npm run start:api       # :3000
npm run start:web       # :4200, proxied to the API
npm run start:worker    # no HTTP port; claims the scheduled jobs

curl http://localhost:3000/health/ready
```

The BPMN engine is optional and starts separately. Without it every screen
still works and cases are worked by hand; with it, work is coordinated and
tasks appear in the right inbox.

```bash
cd apps/bpmn-engine && mvn -DskipTests package
OIDC_CLIENT_SECRET=bpmn_local_dev_only java -jar target/bpmn-engine-0.1.0.jar
# then, as admin-tax:  POST /api/v1/processes/deploy/standard
```

Expected:

```json
{
  "status": "up",
  "checkedAt": "...",
  "components": { "database": { "status": "up" }, "redis": { "status": "up" } }
}
```

---

## Local services

| Service             | Host port   | Credentials                  |
| ------------------- | ----------- | ---------------------------- |
| PostgreSQL          | **5433**    | `tas` / `tas_local_dev_only` |
| Redis               | **6380**    | —                            |
| Keycloak            | **8085**    | `admin` / `admin`            |
| MinIO API / console | 9000 / 9001 | `tas` / `tas_local_dev_only` |
| Mailpit SMTP / UI   | 1025 / 8025 | —                            |
| API                 | 3000        | —                            |

### Why 5433, 6380 and 8085

A native install listening on the default port **silently shadows the container**, and the symptom never points at the cause:

| Default | Shadowed by       | What you see                                                                            |
| ------- | ----------------- | --------------------------------------------------------------------------------------- |
| 5432    | native PostgreSQL | `password authentication failed` — the connection succeeded, against the _wrong server_ |
| 6379    | native Redis      | authorisation denies everything; the cache is real but empty                            |
| 8081    | local Tomcat      | a **Tomcat 404** from Keycloak's token endpoint                                         |

All three were hit during setup. Override with `DB_PORT` / `REDIS_PORT` / `KEYCLOAK_PORT` in `.env`.

To check what owns a port on Windows:

```bash
netstat -ano | grep ":5432"
tasklist //FI "PID eq <pid>"
```

### Test users

Realm `tax-assessment`, password `password` for all:

| User                | Role                                      |
| ------------------- | ----------------------------------------- |
| `assessor`          | `TA_ASSESSOR` — prepares assessments      |
| `reviewer`          | `TA_REVIEWER`                             |
| `approver`          | `TA_APPROVER_L1`                          |
| `supervisor`        | `TA_SUPERVISOR` — sees the whole register |
| `notice-issuer`     | `TA_NOTICE_ISSUER`                        |
| `objection-officer` | `TA_OBJECTION_OFFICER`                    |
| `appeals-officer`   | `TA_APPEALS_OFFICER`                      |
| `committee-member`  | `TA_COMMITTEE_MEMBER`                     |
| `admin-tax`         | `TA_ADMIN`                                |
| **`acme-finance`**  | `TA_TAXPAYER` — for the portal            |

`tas-bpmn` is a service account, not a login: it holds `SYSTEM`, which is
granted exactly the three routes a service task calls.

Officer accounts also hold `MFA_REQUIRED`, and the realm carries a conditional
one-time-code flow. It is **not bound** as the browser flow: binding it makes
every officer enrol an authenticator on next sign-in, which stops the local
walkthrough and the scripted checks. Bind it per environment — Keycloak admin,
Authentication, Flows, `officer-mfa-browser`, Bind flow.

---

## Daily commands

```bash
npm run verify          # everything CI runs — do this before pushing
npm run test            # all workspaces
npm run lint            # includes boundary and money rules
npm run typecheck       # project references, whole repo
npm run format          # write
npm run format:check    # verify

npm run dev:up          # start infrastructure
npm run dev:down        # stop, keep data
npm run dev:reset       # destroy volumes and rebuild — nuclear option
npm run dev:logs        # tail container logs

npm run db:migrate
npm run db:migrate:undo
npm run db:seed

npm run start:api       # :3000
npm run start:web       # :4200
npm run start:worker    # schedulers only
```

Against a running stack, and deliberately **not** part of `npm test` — each
needs the containers up and the API listening:

```bash
npm run security:probe  # 44 authorisation, input and header checks
npm run dr:rehearse     # back up, restore to a scratch database, compare
npm run load:seed       # 920,003 cases;  npm run load:seed -- --clean  removes them
```

Per-package:

```bash
cd packages/decimal && npx jest --coverage --watch
npx jest --config apps/api/jest.config.js --rootDir apps/api <path/to.spec.ts>
npm run test --workspace @tas/web      # headless Chrome
```

---

## Writing code here

### Money

Never a JS `number`. Never `+`, `Math.round`, or `toFixed` on an amount.

```ts
import { Money, RoundingMode } from '@tas/decimal';

const base = Money.of('125000.00', 'GBP');
const tax = base.multiply(Money.percent('19')).round({ scale: 0, mode: RoundingMode.HALF_UP }); // rule from the rule set
```

Rounding has no default on purpose — the mode is jurisdiction configuration (`tax_rule_set.rounding_rule`), and a default would be a silent wrong answer somewhere. See [ADR-007](adr/ADR-007-money-representation.md).

### Status transitions

Never assign `status_code` directly. Go through the state machine so an out-of-order transition is rejected rather than silently applied:

```ts
import { assertTransition, ActionCode } from '@tas/contracts';

const transition = assertTransition(currentStatus, ActionCode.ACCEPT, caller.roleCodes);
// throws InvalidTransitionError or UnauthorisedTransitionError
```

Every status change writes exactly one `tax_assessment_event`, **in the same transaction**.

### Migrations

```bash
npx sequelize-cli migration:generate --name add-something --migrations-path db/migrations
```

- Forward-only; write a `down` where feasible.
- Money columns are `DECIMAL(20,4)`.
- Foreign keys `ON DELETE RESTRICT`.
- Audit columns on every mutable table.
- Register new API routes in the permission catalogue **in the same migration**, or the route is unreachable — authorisation fails closed.

### Getting a token locally

```bash
KC=http://localhost:8085/realms/tax-assessment/protocol/openid-connect/token

TOKEN=$(curl -s -X POST "$KC" \
  -d client_id=tas-web \
  -d username=assessor \
  -d password=password \
  -d grant_type=password | jq -r .access_token)

curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/me
```

`/api/v1/me` returns the caller's roles and the exact set of routes they may
invoke — the fastest way to see whether a permission seed did what you meant.

The realm adds an **audience mapper** putting `tas-api` in the token's `aud`.
Keycloak does not do this by default, and the API validates audience rather
than ignoring it.

### New API route checklist

1. Controller and DTO with `class-validator`.
2. **Permission row seeded by migration.** Authorisation fails closed: an
   unregistered route returns 403 to everyone, including administrators. The
   log says `ROUTE_NOT_REGISTERED` when this bites.
3. Record-level scope predicate in the **service**, not the controller.
4. `Idempotency-Key` required if it changes state externally (calculate, finalise, notices, serve, liability).
5. OpenAPI annotations — the front-end client is generated from them.
6. RBAC test for each role that should and should not reach it.
7. If it lists anything, use the standard contract — `page`, `pageSize`,
   `sort`, filters — and resolve every column key through the source's
   allowlist (ADR-016). Never interpolate a caller's text into SQL, including
   into an `ORDER BY`.

There are 122 routes and 117 permission rows. The catalogue is the reason an
unregistered route is unreachable rather than open.

### Registers, exports and the allowlist

A register's columns are configuration (`platform.grid_definition`), but a
definition names a **column key** and the server maps that key to SQL through a
fixed map in code. Adding a column means one entry in the map plus a
configuration row; there is no path by which configuration contributes SQL.

The same map governs sorting and what an export may contain, so a column cannot
be exportable but unrenderable. See ADR-016.

Register sources are published into the platform's registry at boot — the
platform cannot import the domain (plan 14.2), so the dependency runs the other
way:

```ts
onModuleInit(): void {
  this.grids.register(this);   // RegisterGridSource -> GridService
}
```

### Display keys

Every user-visible string. No hard-coded English:

```ts
{ labelKey: 'ta.field.assessedAmount', errorKey: 'ta.error.assessedAmount.negative' }
```

---

## Testing

| Level       | Location                                        | Command                             |
| ----------- | ----------------------------------------------- | ----------------------------------- |
| Unit        | `packages/*/test`, `apps/api/src/**/*.spec.ts`  | `npm test`                          |
| Integration | `apps/api/test`                                 | Needs `npm run dev:up`              |
| Golden-case | `apps/api/test/golden-cases.spec.ts` + fixtures | `npm test`; blocking                |
| Browser     | `apps/web/src/**/*.spec.ts`                     | `npm run test --workspace @tas/web` |
| Live probe  | `scripts/security/boundary-probe.js`            | `npm run security:probe`            |
| Recovery    | `scripts/dr/rehearse.sh`                        | `npm run dr:rehearse`               |

516 tests: 282 API, 108 dynaforms-core, 74 decimal, 30 web, 22 contracts.

Bars that are enforced rather than aspirational:

- `@tas/decimal`: **100%** statements, branches, functions, lines.
- Calculation and deadline packages: **90%+**, with **100% branch on rounding**.
- Golden-case fixtures: any change to an expected value needs a tax-SME approver on the PR.

**There is no Playwright suite.** The multi-role journey is covered by the
integration tests plus the live probe, and the honest position is that neither
is an end-to-end browser test. `docs/testing.md` says the same.

---

## Troubleshooting

**`password authentication failed for user "tas"`**
A native PostgreSQL is shadowing the container on 5432. Confirm `DB_PORT=5433` in `.env` and that `docker port tas-postgres` shows `5433`.

**`ERROR: type "citext" does not exist` during `npm run db:migrate`**

The migration is running against the **wrong PostgreSQL**. `citext`,
`pgcrypto` and `btree_gist` are created by `deploy/docker/init-db.sql`, which
runs once when the container's data volume is first created. A native
PostgreSQL on your machine never ran it, so the extensions are absent and the
first migration that needs one fails.

Check where the migration is actually pointing:

```bash
grep -E "^DB_(HOST|PORT|USER|NAME)" .env     # what sequelize-cli will use
netstat -ano | grep -E ":5432|:5433"          # who is listening
docker port tas-postgres                      # the container's host port
```

`DB_PORT=5432` with `DB_USER=postgres` means a native install; the project's
container is `5433` / `tas`. Fix `.env` to match `.env.example`:

```
DB_HOST=localhost
DB_PORT=5433
DB_USER=tas
DB_PASSWORD=tas_local_dev_only
DB_NAME=tax_assessment
```

Confirm the extensions exist before re-running:

```bash
docker exec tas-postgres psql -U tas -d tax_assessment -c "select extname from pg_extension order by 1"
# btree_gist, citext, pgcrypto, plpgsql
```

Then `npm run db:migrate` reports "No migrations were executed" if the
container was already up to date, which is the answer you want.

**Clean up the stray half-migration.** A run against the wrong server leaves
schemas and a `platform.sequelize_meta` row behind in _that_ database. It is
harmless but it will confuse the next diagnosis, and it is not in a database
this project manages — check before dropping anything:

```bash
psql -h localhost -p 5432 -U postgres -d tax_assessment \
  -c "select table_schema, count(*) from information_schema.tables
       where table_schema in ('platform','forms','workflow','tax') group by 1"
```

The same class of failure with a different symptom — `password authentication
failed for user "tas"` — is the entry above. Both are one cause: a native
service shadowing the container.

**`MissingConfigurationError: Required configuration DB_PASSWORD is not set`**
`cp .env.example .env`. Configuration is validated at boot deliberately — a system that starts with no database password and then fails open on authorisation is worse than one that refuses to start.

**`The "class-validator" package is missing`**
`npm install` at the repository root; workspace links may be stale.

**Readiness returns 503 with `redis: down`**
Correct behaviour, not a bug. Authorisation fails closed, so an instance that cannot reach Redis must leave the load balancer. Start it: `npm run dev:up`.

**Every route returns 403, including as an administrator**
The authorisation catalogue could not load, or the route is not registered.
Check the API log: `ROUTE_NOT_REGISTERED` means you need a permission row;
`Authorization catalogue unavailable` means Redis or the database is
unreachable. Both deny by design.

**Token rejected with `missing required "aud" claim`**
The Keycloak client has no audience mapper. The realm import includes one for
`tas-web`; if you recreated the realm by hand, add it, and do not work around
it by disabling audience validation.

**Keycloak returns a Tomcat 404**
Something else owns port 8085 (or 8081 if you overrode it). See the port table
above.

**Keycloak will not start**
It needs Postgres healthy first. `npm run dev:logs` and check `tas-postgres` is ready; Keycloak retries but gives up eventually.

**Migration applied but table missing**
Check the schema — tables live in `platform`, `forms`, `workflow` or `tax`, never `public`. `\dt tax.*` in psql.

**Tests hang after passing**
An open handle, usually a Sequelize or Redis client not closed in a test teardown. Run `npx jest --detectOpenHandles`.

---

## Committing

Conventional Commits:

```
feat(tax-assessment): add adjustment normalisation on submit
fix(decimal): correct HALF_EVEN at negative half-way values
docs(adr): record the workflow engine decision
```

Reference an ADR for anything architectural. If a change alters a module boundary, a technology choice, or how money, dates, identity or audit work, it needs an ADR before it needs a review.
