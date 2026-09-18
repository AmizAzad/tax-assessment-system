# Tax Assessment System

A configuration-driven tax assessment platform. A tax authority can initiate, prepare, compute, review, approve, issue, serve, dispute and close tax assessments — and adding a new tax type or a new jurisdiction is a **configuration change, not a release**.

> **Status: phases 0 to 8 built, front end and back end, and exercised end to end against a running stack.** A case can be opened, evidenced, adjusted, calculated, reviewed, approved, finalised, noticed, served, objected to, appealed, reassessed, settled and closed — through the browser. A second jurisdiction runs on configuration alone. What is _not_ done is listed plainly in [Still outstanding](#still-outstanding); the tax figures in particular have not been through a subject-matter expert.

---

## The one rule

> **Forms display. The server decides. Nothing that determines a legal figure or a statutory date may execute in a browser.**

Everything else in this codebase follows from that. Tax computation is server-side, decimal-exact, traced and versioned. Statutory deadlines are computed on the server against a stored service date and rendered read-only. A form's on-screen formula is an assistance feature and a cross-check — never the legal figure.

If you are about to compute money in a component, a form formula, or with a JavaScript `number`, stop and read [ADR-007](docs/adr/ADR-007-money-representation.md).

---

## Quick start

**Prerequisites:** Node 22+, Docker, and (for the BPMN engine only) Java 17+ and Maven.

```bash
git clone <repo-url> tax-assessment-system
cd tax-assessment-system

npm install
cp .env.example .env

npm run dev:up          # Postgres, Redis, Keycloak, MinIO, Mailpit
npm run db:migrate      # Schema, permissions, rule sets, form templates
npm run verify          # Format, lint, typecheck, test

npm run start:api       # :3000
npm run start:web       # :4200
npm run start:worker    # no HTTP port; runs the schedulers
```

Then:

```bash
curl http://localhost:3000/health/ready
powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1
```

The BPMN engine is optional and separate. Without it, cases are worked by hand
and every screen still functions; with it, work is coordinated and tasks
appear in the right inbox:

```bash
cd apps/bpmn-engine && mvn -DskipTests package
OIDC_CLIENT_SECRET=bpmn_local_dev_only java -jar target/bpmn-engine-0.1.0.jar
# then, signed in as admin-tax:
#   POST /api/v1/processes/deploy/standard
```

On Windows, follow **[docs/running-locally.md](docs/running-locally.md)** instead — it covers the port collisions and the PowerShell recipes.

| Service                   | URL                            | Credentials                  |
| ------------------------- | ------------------------------ | ---------------------------- |
| API                       | http://localhost:3000          | —                            |
| OpenAPI                   | http://localhost:3000/api/docs | —                            |
| Keycloak                  | http://localhost:8085          | `admin` / `admin`            |
| MinIO console             | http://localhost:9001          | `tas` / `tas_local_dev_only` |
| Mailpit (captured e-mail) | http://localhost:8025          | —                            |
| PostgreSQL                | `localhost:5433`               | `tas` / `tas_local_dev_only` |
| Redis                     | `localhost:6380`               | —                            |

**Ports 5433, 6380 and 8085 are deliberate.** A native PostgreSQL, Redis or Tomcat on 5432/6379/8081 silently shadows the container: Postgres surfaces as a baffling `password authentication failed` against the _wrong server_, and a shadowed Keycloak returns a Tomcat 404 from the token endpoint. Override with `DB_PORT` / `REDIS_PORT` / `KEYCLOAK_PORT` in `.env`.

Local sign-in users (realm `tax-assessment`, password `password` for all):
`assessor`, `reviewer`, `approver`, `supervisor`, `notice-issuer`,
`objection-officer`, `appeals-officer`, `committee-member`, `admin-tax`, and
**`acme-finance`** — a taxpayer, for the portal.

Officer accounts hold `MFA_REQUIRED` and the realm carries a conditional
one-time-code flow, but it is **not bound** as the browser flow: binding it
makes every officer enrol an authenticator on next sign-in, which would stop
the walkthrough dead. Switching it on is one bind in the Keycloak console —
see [running locally §25](docs/running-locally.md).

---

## What this system does

An assessment moves through fourteen stages, driven by a BPMN process:

```
Initiation -> Data Retrieval -> Case Creation -> Preparation -> Calculation
   -> Review -> Approval -> Finalisation -> Notice Generation -> Service
      -> [ Objection -> Appeal -> Reassessment ] -> Closure
```

Five things make it a platform rather than one authority's application:

| Concern                         | Mechanism                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| **Forms** are configuration     | DynaForms JSON templates, authored in a builder, rendered at runtime                |
| **Process** is configuration    | BPMN 2.0 definitions executed by Flowable, with statutory timers                    |
| **Tax rules** are configuration | Versioned, effective-dated rule sets: rates, bands, thresholds, penalties, interest |
| **Deadlines** are configuration | Anchor event + offset + calendar rule, with holiday and extension handling          |
| **Registers** are configuration | `grid_definition` rows decide a register's columns, their order and what exports    |

The acceptance test for "configuration, not code" was deliberate, and it has
been run: **Saudi Arabia is configured end to end with no code change** —
Friday/Saturday weekend, SAR, flat 20% with no marginal relief, 120-day
deadlines, committee appeal forums, 360-day interest. It found exactly one
hard-coded assumption, a `?? 'GBP'` currency default, which is what the
exercise exists to do.

---

## Architecture

```
Angular SPA  ->  NestJS API  <->  Flowable BPMN engine
                     |
                     +-> PostgreSQL (platform | forms | workflow | tax schemas)
                     +-> Redis        (authorisation cache, queues)
                     +-> Object store (evidence, notices)
                     +-> Keycloak     (authentication)
                     +-> Worker       (schedulers, PDF, reconciliation)
```

Four deployable units. A **modular monolith**, not microservices — the boundaries below are module boundaries first and become service boundaries only if load or team structure demands it.

| Unit               | Responsibility                                                 |
| ------------------ | -------------------------------------------------------------- |
| `apps/api`         | All domain modules, synchronous request handling               |
| `apps/worker`      | Schedulers, queues, PDF rendering, reconciliation              |
| `apps/bpmn-engine` | Flowable 7 + the `apiInvoker` delegate. **No tax logic, ever** |
| `apps/web`         | Angular SPA                                                    |

### Module boundaries

```
tax-assessment  ->  workflow, forms, platform, packages
workflow        ->  platform, packages
forms           ->  platform, packages
platform        ->  packages
```

**Nothing imports from `tax-assessment`.** This is what keeps the platform reusable and the domain replaceable, and it is enforced by `import/no-restricted-paths` in CI rather than by good intentions.

### Repository layout

```
apps/
  api/              NestJS modular monolith
  worker/           Schedulers, queues, PDF rendering
  bpmn-engine/      Spring Boot + Flowable (Java 17)
  web/              Angular SPA
packages/
  decimal/          Money type and statutory rounding  <- read this first
  contracts/        Shared enums, status codes, case state machine
  dynaforms-core/   Form engine, framework-agnostic  <- runs on both sides
  dynaforms-angular/ Reserved. The renderer and builder live in apps/web
  testing/          Reserved. Fixtures live with the suites that use them
db/migrations/      Forward-only, sequelize-cli
db/bpmn/            The process definition shipped with the release
scripts/            Smoke test, boundary probe, DR rehearsal, load seeding
docs/adr/           Architecture decision records
docs/uat/           The user-acceptance pack
plans/              The architecture and implementation plan
```

`dynaforms-angular` and `testing` are placeholders, and are named here so that
nobody goes looking for the code in them. The Angular renderer and visual
builder are real and are in `apps/web/src/app/dynaforms` and
`apps/web/src/app/features/builder`; the golden-case fixtures are in
`apps/api/test/fixtures`.

---

## Key design decisions

Each links to its ADR. Read these before proposing an architectural change.

| Decision                                                                                                       | Why                                                                                       |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [NestJS / TypeScript backend](docs/adr/ADR-001-backend-stack.md)                                               | One language across form engine, API and SPA. Money safety solved explicitly, not assumed |
| [Flowable as the only workflow engine](docs/adr/ADR-002-workflow-engine.md)                                    | Statutory timers, boundary events and message correlation are hard requirements           |
| [Keycloak for authentication](docs/adr/ADR-003-identity.md)                                                    | We build authorisation. We do not build password handling                                 |
| [Monorepo with enforced boundaries](docs/adr/ADR-004-monorepo.md)                                              | Cross-cutting changes are the norm here                                                   |
| [DynaForms forked, not consumed](docs/adr/ADR-005-dynaforms-fork.md)                                           | Standalone project; we need server-side validation and schema extensions                  |
| [Server-side calculation authority](docs/adr/ADR-006-calculation-authority.md)                                 | The form formula engine is floating-point, unversioned and untraced                       |
| [Money as an exact decimal type](docs/adr/ADR-007-money-representation.md)                                     | JavaScript `number` cannot represent currency                                             |
| [JSONB boundaries](docs/adr/ADR-008-jsonb-boundaries.md)                                                       | Configuration and captured payloads may be JSON; computed facts may not                   |
| [The event ledger is the system of record](docs/adr/ADR-009-event-ledger-system-of-record.md)                  | Six sources record what happened; exactly one of them is authoritative                    |
| [Provider interfaces](docs/adr/ADR-010-provider-interfaces.md)                                                 | A third party's outage must not become a tax outcome                                      |
| [Append-only by trigger, not by grant](docs/adr/ADR-013-append-only-audit-enforcement.md)                      | An owner can re-grant what it revoked; a trigger binds it anyway                          |
| [Configuration resolves through an allowlist](docs/adr/ADR-016-configuration-resolves-through-an-allowlist.md) | Otherwise register configuration is an injection route with an admin screen               |

---

## Current state

### Done and verified

| Component                                                                                                      | Evidence                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Monorepo, workspaces, TypeScript project references                                                            | `npm run typecheck` passes                                                                                       |
| `@tas/decimal` — `Money`, statutory rounding, allocation                                                       | **74 tests, 100% statement/branch/function/line coverage**                                                       |
| `@tas/contracts` — statuses, enums, roles, case state machine                                                  | **22 tests**, including structural invariants                                                                    |
| Local environment (Postgres, Redis, Keycloak, MinIO, Mailpit)                                                  | `npm run dev:up`                                                                                                 |
| Database: 4 schemas, 82 tables, 28 migrations                                                                  | Every one applied, rolled back and re-applied clean                                                              |
| **Authentication** — Keycloak JWT, JWKS, audience validation                                                   | Verified against real tokens                                                                                     |
| **Authorisation** — permission catalogue, Redis cache, fail-closed                                             | **35 tests** incl. the fail-closed suite                                                                         |
| **Request context** — AsyncLocalStorage, correlation id, SYSTEM context                                        | —                                                                                                                |
| **User auto-provisioning** from IdP subject                                                                    | Verified end to end                                                                                              |
| **Entity history** — generic before/after audit, config-driven                                                 | —                                                                                                                |
| Masters module + demo jurisdiction seed                                                                        | `GET /api/v1/masters/:groupCode`                                                                                 |
| **`@tas/dynaforms-core`** — element model, dependency, validation, formula engines                             | **108 tests**; framework-free, server/client parity proven                                                       |
| **Server-side form validation** in the API                                                                     | **9 tests**; same code the browser runs                                                                          |
| **BPMN engine** (Flowable 7, Java 17) + **`apiInvoker` delegate**                                              | **6 integration tests** against a running engine                                                                 |
| **Publish-time BPMN validation** (role-less task rejection)                                                    | **22 tests**; fails closed                                                                                       |
| **Workflow read model** + webhook ingestion                                                                    | **10 integration tests** against PostgreSQL                                                                      |
| **Engine client, task inbox, reconciliation job**                                                              | Read model served; engine never on a read path                                                                   |
| **Documents** — S3/MinIO, SHA-256 checksums, signed URLs, access log                                           | Integrity verified on every read                                                                                 |
| **Notifications** — types, templates, queue, SMTP dispatch, history                                            | Queue-then-send; history is the comms audit                                                                      |
| **API trace + redaction**                                                                                      | **20 tests**; allowlist, so an unknown field is redacted                                                         |
| **Scheduler + job registry**                                                                                   | Cross-replica mutual exclusion                                                                                   |
| **i18n** — languages, bundles, RTL                                                                             | Public endpoint for the SPA                                                                                      |
| **Form templates + submissions**                                                                               | Clone-per-year; supersession chain                                                                               |
| **Reference numbers**                                                                                          | **17 tests** incl. 25-way concurrency                                                                            |
| **Angular SPA** — Keycloak PKCE, permission-filtered nav, RTL                                                  | Builds and runs on :4200                                                                                         |
| **DynaForms renderer** — runs the same engines as the server                                                   | Live demo at /forms/preview                                                                                      |
| **DynaForms visual builder** — palette, tree, properties, rule editor, live preview                            | Authors and publishes templates at /forms/builder                                                                |
| **Assessment domain schema** — 34 tax tables, exclusion constraints                                            | Overlapping rule sets and approval bands are unrepresentable                                                     |
| **Case lifecycle** — 44 transitions, roles per action, ledger events                                           | Status changes only via `transition()`, in one transaction with its event                                        |
| **Segregation of duties** — prior-capacity check, fails closed                                                 | Refuses an assessor acting as their own reviewer; **403 verified live**                                          |
| **Evidence snapshot** — provider fan-out, freeze, SHA-256 hash                                                 | A failed mandatory source blocks DATA_READY rather than assessing on nothing                                     |
| **Filing provider** — maps a return to tax concepts via the template                                           | Mapping is configuration (`taxConcept`), not code per form version                                               |
| **Taxpayer account** — payments, credits, losses, duplicate guard                                              | Same bank reference cannot be credited twice                                                                     |
| **Calculation pipeline** — 9 steps, pure, full trace                                                           | **39 golden-case tests**, incl. band-boundary continuity and monotonicity                                        |
| **UK CIT FY2024 rule set** — bands, marginal relief, penalties, interest                                       | Seeded as data; `GB-CIT-FY2024 v1 PUBLISHED`                                                                     |
| **Deadline engine** — anchor, offset, secondary offset, calendar rule                                          | **13 tests**: month-end clamping, leap years, timezone invariance                                                |
| **Approval routing** — delegation bands by amount                                                              | Band chosen from configuration, never by the caller                                                              |
| **Finalisation** — consumes losses under row lock, freezes figures                                             | Recalculating a finalised case returns 409                                                                       |
| **Domain error mapping** — 403/409/400 instead of blanket 500                                                  | A refusal is distinguishable from a fault                                                                        |
| **Notices** — wording templates, token substitution, PDF, content hash                                         | **17 tests**; a template that could compute is refused                                                           |
| **Notice verification** — recompute the hash from stored content                                               | Over the content, not PDF bytes, so a re-render is not reported as tampering                                     |
| **Service and proof** — per-channel attempts, deemed service, outcomes                                         | A returned letter reverts the notice to unserved and re-anchors the objection clock                              |
| **Business-day calendar** — holidays plus a configurable weekend                                               | **19 tests**; a Friday–Saturday weekend is configuration, not code                                               |
| **Deadline materialisation + SLA sweeper**                                                                     | Deadlines become rows a scheduler watches, not arithmetic nobody runs                                            |
| **Objections** — lateness computed, admissibility decided, panel opinions                                      | A decision against the panel majority is permitted and logged                                                    |
| **Appeals** — forum from master data, hearings, outcome, implementation                                        | Implementation tracked separately: a win never applied is the failure that matters                               |
| **Reassessment** — in place after a dispute, successor after closure                                           | A limitation override needs a reason and an identified authoriser                                                |
| **Calculation delta** — line-by-line movement between versions                                                 | Exact through `Money`, not accumulated float error                                                               |
| **Settlement** — evaluated from payments, never asserted                                                       | Nobody can press "paid"                                                                                          |
| **Closure** — frozen balance, retention class, legal hold                                                      | A hold outranks retention; disposal is a list, never an automatic delete                                         |
| **Reporting** — summary, collection, adjustments, disputes, ageing, exposure                                   | Amounts as strings, so a pack ties back to the register                                                          |
| **Reconciliation report** — where the register contradicts itself                                              | Empty is the expected answer                                                                                     |
| **Second jurisdiction (SA)** configured with no code change                                                    | Different weekend, currency, rate shape, deadlines, forums — **the Phase 8 acceptance test**                     |
| **Angular SPA for the whole domain** — register, workbench, queues, disputes, selection, rules, reports, admin | 16 lazy-loaded feature areas; every screen backed by a verified endpoint                                         |
| **Case workbench** — 9 tabs incl. the calculation trace and the process journey                                | Renders server figures verbatim; the browser does no arithmetic                                                  |
| **Risk-based selection** — weighted indicators, scored candidates                                              | Scoring and opening cases are separate acts; rules carry no SQL                                                  |
| **Rule simulator** — replay a draft over historic cases                                                        | Persists nothing; refuses a published set                                                                        |
| **SLA clocks** — started and stopped by transitions                                                            | Previously the sweeper watched an empty table                                                                    |
| **Objection deposits** — percentage with floor and cap                                                         | Required in SA, not in GB; both are data                                                                         |
| **`apps/worker`** — scheduled work in its own process                                                          | Boots the same domain modules with no HTTP port                                                                  |
| **Cross-replica job locking** on every scheduled job                                                           | Two replicas cannot double-send a deadline warning                                                               |
| **Load tested at 920,003 cases**                                                                               | Filtered register page 42 ms; unfiltered 244 ms                                                                  |
| **BPMN process integration, two-way**                                                                          | A case opens, a process starts, the engine retrieves evidence, a task lands in the right inbox                   |
| **Engine service account** — one role, two granted routes                                                      | Least privilege, not a shared secret that skips authorisation                                                    |
| **Taxpayer portal** — own cases, notices, objections, account                                                  | A taxpayer never supplies the identifier deciding whose data they see                                            |
| **Rate limiting**, enforced                                                                                    | 429 at attempt 21 against a limit of 20; the public route limited separately                                     |
| **Security property tests** (14)                                                                               | The attacks a penetration test looks for, held still in the build                                                |
| **Live boundary probe**                                                                                        | **44/44**: anonymous access, forged tokens, IDOR, role separation, injection, export scope, headers, rate limits |
| **DR rehearsal** — backup, restore, fingerprint compare                                                        | Match on every figure, hash and count; 8s recovery on the demo corpus                                            |
| **Append-only audit** — triggers, not just grants                                                              | UPDATE and DELETE on the event ledger refused at the database, owner included                                    |
| **Configurable registers** — `grid_definition` drives the columns                                              | The register's columns are a data row; the server resolves keys through an allowlist, never SQL                  |
| **Export** — CSV and XLSX, queued above a threshold                                                            | **18 tests**; formula injection neutralised, money written as exact text                                         |
| **Dashboard** — tiles, charts, ageing, SLA and statutory exposure                                              | Scoped to the caller by the same predicate as the register; assessed and collected never summed                  |
| **Process journey** — the diagram with the case's position on it                                               | **12 tests** for the layout, **5** for the rendering; a case with no process says so                             |
| **BPMN modeller** — bpmn-js with a Flowable property panel                                                     | The panel offers only what the validator accepts; round-trips `candidateGroups`, `stepCode`, `formId`            |
| **Public notice verification**                                                                                 | Reachable without an account; returns status only, rate limited, 2^122 reference space                           |
| **Security headers and CORS allowlist**                                                                        | `default-src 'none'`, `frame-ancestors 'none'`, no `X-Powered-By`, named origins                                 |
| **Draft autosave and offline tolerance**                                                                       | Held in the browser, never posted half-finished; a restored draft is announced, not applied silently             |
| **Accessibility** — focus visibility, skip link, tab-list keyboard pattern                                     | One tab stop for nine tabs, arrow keys between them                                                              |
| **MFA configured** for officer accounts                                                                        | A conditional OTP flow in the realm, verified by import; not bound locally, one line to bind                     |
| **Adjustment form as a DynaForms template**                                                                    | `TA-06-ADJUSTMENT` published; the workbench renders configuration, and display keys resolve through the bundle   |
| **Dependency audit clean**                                                                                     | `npm audit --audit-level=high` passes; six high advisories in the transitive tree pinned out                     |
| Lint rules for module boundaries and money arithmetic                                                          | Both verified by watching them fail                                                                              |
| CI pipeline                                                                                                    | `.github/workflows/ci.yml`                                                                                       |

### Current state

**Phases 0 to 8 are complete**, front end and back end, and exercised end to end
against the running stack.

The whole lifecycle works through the browser:

```
INITIATED --(evidence, SYSTEM)--> DATA_READY --> ASSIGNED --> IN_PREPARATION --> CALCULATED
  --> UNDER_REVIEW --> REVIEWED --(routed by amount)--> PENDING_APPROVAL --> APPROVED --> FINALISED
  --> NOTICE_GENERATED --(served, deemed date)--> NOTICE_SERVED --> AWAITING_TAXPAYER_RESPONSE
  --> UNDER_OBJECTION --> OBJECTION_REJECTED --> UNDER_APPEAL --> APPEAL_VARIED
  --(reassessed in place)--> ... --> FINALISED --> SETTLED --> CLOSED
```

On the demo company that produces a complete, auditable file: an assessment of
GBP 16,742; an objection rejected with reasons; an appeal varied by the
tribunal; a reassessment reducing the figure to GBP 12,483; payment;
settlement; and closure with a frozen balance and a seven-year retention date.

**The second jurisdiction is the configurability result.** Saudi Arabia runs end
to end — Friday/Saturday weekend, SAR, flat 20% with no marginal relief,
120-day deadlines, committee appeal forums, 360-day interest — with **no code
change**. Adding it found exactly one hard-coded assumption, a `?? 'GBP'`
currency default, which is what the exercise exists to do.

### Numbers, at the time of writing

| Measure                     | Count                                                                   |
| --------------------------- | ----------------------------------------------------------------------- |
| Migrations                  | 28, each rolled back and re-applied clean                               |
| Tables                      | 82 across four schemas                                                  |
| API routes                  | 122, every one in the permission catalogue                              |
| Permissions                 | 117                                                                     |
| Web feature areas           | 16, lazy-loaded                                                         |
| Tests                       | **516** — 282 API, 108 dynaforms-core, 74 decimal, 30 web, 22 contracts |
| Live boundary checks        | 44, against a running stack                                             |
| Dependency advisories, high | 0 (`npm audit --audit-level=high`)                                      |

### The screens

| Area                 | What it does                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Dashboard**        | Tiles, workload and throughput charts, ageing bands, service levels and statutory deadlines                     |
| **Register**         | Columns from configuration, server-side paging and sorting, search, CSV and XLSX export                         |
| **Workbench**        | Nine tabs: evidence, adjustments, calculation, deadlines and SLA, notices, disputes, closure, journey, timeline |
| **Queues**           | Seven stage queues with counts, from preparation to dispute                                                     |
| **Disputes**         | Objections and appeals across the register, including decided-but-not-implemented                               |
| **Selection**        | Score taxpayers against risk rules, see why each was picked, open cases                                         |
| **Rule sets**        | Rate configuration, notice wording, and the draft simulator                                                     |
| **Reports**          | Seven management reports plus the reconciliation check                                                          |
| **Process modeller** | Author the coordination process, validate it against the deployment rules, deploy it                            |
| **Portal**           | What a taxpayer sees: their assessments, notices, what they owe, how to object                                  |
| **Administration**   | Route catalogue, delegation limits, scheduled jobs, my own access                                               |

Plus the Phase 1 screens that were already there: form renderer, visual form
builder, reference data, task inbox.

The register's columns are **not** in the front-end code. They are a row in
`platform.grid_definition`, and a deployment that wants the limitation date in
front of every caseworker changes that row rather than a component.

### Processes

| Process            | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `apps/api`         | HTTP API, 122 routes                              |
| `apps/web`         | Angular SPA, lazy-loaded per feature              |
| `apps/worker`      | Scheduled work, no HTTP port, same domain modules |
| `apps/bpmn-engine` | Flowable 7 with the `apiInvoker` delegate         |

Every scheduled job claims a cross-replica lock, so running the API and the
worker together is safe, and so is more than one of either.

### Measured

Load tested at **920,003 cases** with 200,000 taxpayers:

| Endpoint                              | Total  |
| ------------------------------------- | ------ |
| `GET /cases?status=UNDER_REVIEW`      | 42 ms  |
| `GET /cases?pageSize=25` (unfiltered) | 244 ms |
| `GET /reports/assessment-summary`     | 274 ms |
| `GET /reports/ageing`                 | 433 ms |

The database accounts for 80–100 ms of the slowest two, both parallel
aggregates over the whole register. `scripts/load/seed-register.js` seeds and
cleans this corpus.

### Still outstanding

Four things, and they need decisions or inputs I cannot supply:

- **Tax content is not certified.** Every UK and SA rate, penalty, interest
  figure and deadline is illustrative and carries an SME sign-off caveat. They
  are configuration, so correcting one is a data change rather than a release.
- **Notices render in Latin scripts only.** `pdfkit` uses built-in Latin-1
  fonts. An Arabic notice is _refused_ rather than rendered blank — correct
  behaviour, but the Saudi jurisdiction cannot issue Arabic PDFs until a font
  is embedded and right-to-left shaping added.
- **Evidence providers are both internal.** The filing store and taxpayer
  account read our own tables. No live bank feed, withholding register or
  third-party data integration exists; the provider port is there for them.
- **MFA is configured but not switched on locally.** The realm carries a
  conditional OTP flow and every officer account holds `MFA_REQUIRED`;
  `browserFlow` is deliberately left unbound so the walkthrough and the
  scripted checks still work. Binding it is one line, and it is an
  environment's decision rather than the build's.

One partial deviation from the plan, stated rather than buried:

- **Only the adjustment form is a DynaForms template so far.** Plan 18.2 says
  the working area is always the renderer. The adjustment form —
  `TA-06-ADJUSTMENT`, the one an officer fills in most — now is: its fields,
  its reason codes and its buttons are a published template, and adding a
  reason code for a jurisdiction is an edit in the form builder. The dispute
  forms (objection grounds, appeal details) are still written as markup, and
  until they are templates too a jurisdiction needing different objection
  grounds needs a code change.

And two things that are done as far as they can be done without other people:

- **Security.** The boundary probe passes 44/44 and 14 property tests hold the
  authorisation model still. That is not a penetration test — a real engagement
  brings chained weaknesses, timing and infrastructure that no script of mine
  covers.
- **UAT.** `docs/uat/` is a prepared pack: environment, scenarios, a findings
  sheet and honest expectations. Running it needs tax officers.

---

## Development

```bash
npm run verify          # format:check + lint + typecheck + test — run before pushing
npm run test            # all workspaces
npm run lint            # boundaries and money rules included
npm run dev:reset       # destroy volumes and rebuild the local stack
npm run db:migrate      # apply migrations
npm run db:migrate:undo # and take the last one back
```

Against a running stack, and deliberately **not** part of `npm test` — each
needs the containers up:

```bash
npm run security:probe  # 44 authorisation, input and header checks
npm run dr:rehearse     # back up, restore to a scratch database, compare fingerprints
npm run load:seed       # 920,003 cases; --clean removes them again
```

### Conventions

| Concern      | Rule                                                                                   |
| ------------ | -------------------------------------------------------------------------------------- |
| Money        | `Money` from `@tas/decimal`. `NUMERIC(20,4)` columns. Never `float`, never JS `number` |
| Tables       | `snake_case`; `id bigserial`; `uuid` on externally addressable entities                |
| Foreign keys | `ON DELETE RESTRICT`. Assessments are never hard-deleted; `is_active` only             |
| Strings      | Every user-visible string is a display key (`ta.field.*`). No hard-coded English       |
| Migrations   | Forward-only. Permissions, menus and display keys seeded by migration                  |
| Routes       | `/api/v1/<resource>`, registered in the permission catalogue by migration              |
| Commits      | Conventional Commits; an ADR referenced for architectural change                       |

### Things that will fail review

- Monetary arithmetic on a `number`, or `Math.round` on money
- A calculation whose result is not traced and not pinned to a rule-set version
- A statutory deadline computed in the browser
- A form rendered with hand-written markup instead of the DynaForms renderer
- Domain code inside `packages/dynaforms-*`
- A BPMN user task with no role codes (it would be open to any authenticated user)
- A new API route not registered in the permission catalogue
- A register column, filter or sort resolved to SQL from configuration rather than through the source's allowlist

The markup rule has one known outstanding exception, recorded in
[Still outstanding](#still-outstanding): the dispute forms. It is a debt, not a
precedent.

---

## Documentation

| Document                                                        | Contents                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **[Running locally](docs/running-locally.md)**                  | **Windows step-by-step: start it, log in, call it, test it**                                            |
| [Architecture](docs/architecture.md)                            | System design, module structure, data model, request lifecycle                                          |
| [Development guide](docs/development.md)                        | Environment setup, workflows, testing, troubleshooting                                                  |
| **[Assessment lifecycle](docs/domain/assessment-lifecycle.md)** | **The case machine, evidence, calculation, deadlines and the controls that make the figure defensible** |
| [Domain glossary](docs/domain/glossary.md)                      | Tax assessment terms as this system uses them                                                           |
| [Testing strategy](docs/testing.md)                             | Levels, gates, the golden-case corpus, and what each suite is evidence of                               |
| [UAT pack](docs/uat/README.md)                                  | Twelve scenarios written as outcomes, severities, and honest expectations                               |
| [Scripts](scripts/README.md)                                    | Smoke test, boundary probe, DR rehearsal, load seeding                                                  |
| [ADRs](docs/adr/)                                               | Architecture decision records                                                                           |
| [V2 plan](plans/V2_tax_assessment_greenfield_plan_11092026.md)  | Full architecture and implementation plan                                                               |
| [V1 plan](plans/V1_tax_assessment_initial_plan_05092026.md)     | Superseded brownfield analysis, retained for reference                                                  |

---

## Open decisions

Tracked in [plan section 29](plans/V2_tax_assessment_greenfield_plan_11092026.md#29-open-questions--decisions-required). The build proceeded on stated assumptions rather than waiting; each is cheap to change because it is configuration, and each is written down here so nobody mistakes an assumption for a requirement.

| #   | Question                                                      | What the build assumed                                                                     | Cost of a different answer                                         |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Q6  | What is the payments / liability ledger, and is there an API? | An internal `taxpayer_account_entry` ledger; settlement is derived from it, never asserted | An adapter behind the same port. Still the largest scope swing     |
| Q1  | Which jurisdiction is v1, and which proves configurability?   | GB is v1; SA proves it, and does so with no code change                                    | Seed rows: rule set, deadlines, calendar, forums                   |
| Q2  | Which tax types are in v1?                                    | CIT only. Legal persons; no natural-person taxpayers exercised                             | A tax type row and a rule set; the calculation pipeline is generic |
| Q5  | Where do declared figures from filed returns come from?       | The internal filing store, mapped to tax concepts by the form template                     | A second evidence provider. The port exists and is fanned out over |

---

## Licence

Proprietary — Amiz Azad. All rights reserved.
