# Architecture

How the system is put together and why. For the decisions behind it, see the [ADRs](adr/). For the full plan, see [V2](../plans/V2_tax_assessment_greenfield_plan_11092026.md).

---

## 1. The governing constraint

> **Forms display. The server decides. Nothing that determines a legal figure or a statutory date may execute in a browser.**

A tax assessment is a legal instrument. It is served on a taxpayer, can be objected to, appealed, and tested in court, and must be reproducible years later from the data as it stood. Three consequences run through every layer:

| Consequence                                                           | Where it shows up                                                                 |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Computation is server-side, decimal-exact, traced and version-pinned  | `tax-assessment/calculation`, `@tas/decimal`, `tax_calculation_result` + `_trace` |
| Statutory deadlines are server-computed against a stored service date | `tax-assessment/deadline`, `tax_assessment_deadline`                              |
| Evidence is frozen, hashed and append-only                            | `tax_assessment_evidence`                                                         |

---

## 2. System shape

```
                         +---------------------------+
                         |      Angular SPA          |
                         |  shell, register,         |
                         |  workbench, admin         |
                         +-------------+-------------+
                                       | HTTPS / JWT
                         +-------------v-------------+
                         |      NestJS API           |
                         |  platform | forms |       |
                         |  workflow | tax-assessment|
                         +--+--------+--------+------+
                            |        |        |
              +-------------+        |        +--------------+
              |                      |                       |
      +-------v------+   +-----------v--------+   +----------v---------+
      |  PostgreSQL  |   |  Flowable engine   |   |  Redis / storage   |
      | platform     |   |  BPMN + apiInvoker |   |  authz cache,      |
      | forms        |   |  (Java 17)         |   |  queues, evidence  |
      | workflow     |   +--------------------+   +--------------------+
      | tax          |              ^
      +--------------+              | service tasks call back into the API
                                    |
                         +----------+----------+
                         |       Worker        |
                         |  schedulers, PDF,   |
                         |  reconciliation     |
                         +---------------------+
```

Four deployable units. A **modular monolith** for the API (ADR-004), not microservices.

| Unit               | Responsibility                                    | Scaling                                       |
| ------------------ | ------------------------------------------------- | --------------------------------------------- |
| `apps/api`         | Domain modules, synchronous request handling      | Horizontal, stateless                         |
| `apps/worker`      | Schedulers, queues, PDF rendering, reconciliation | Horizontal; PDF pool separate (memory-hungry) |
| `apps/bpmn-engine` | Flowable + `apiInvoker`. **No tax logic**         | Horizontal; coordinates through the database  |
| `apps/web`         | Angular SPA                                       | Static / CDN                                  |

Splitting `worker` from `api` on day one is deliberate: a 40-second notice render must never occupy a request thread, and a runaway scheduler must not degrade interactive latency.

---

## 3. Module structure

```
apps/api/src/
  platform/          Identity, RBAC, masters, documents, notifications,
                     audit, scheduling, i18n, grids, export
  forms/             DynaForms host: categories, templates, submissions
  workflow/          Process registry, Flowable client, webhooks, tasks, SLA
  tax-assessment/    Case, evidence, adjustment, calculation, deadline,
                     notice, objection, appeal, selection, event,
                     dashboard, portal, process orchestration
```

### Import direction — enforced, not advisory

```
tax-assessment  ->  workflow, forms, platform, packages
workflow        ->  platform, packages
forms           ->  platform, packages
platform        ->  packages
```

#### The registry pattern, where the rule bites

Register export is a platform capability, and the register it exports is the
domain's. Platform cannot import the domain, so the dependency runs the other
way: `RegisterGridSource` publishes itself into `GridService` at boot, and the
export machinery knows only that something implements `GridSource`. The rule
earns its keep here — the grids and export code is reusable by any domain
built on this platform, because it cannot name one.

**Nothing imports from `tax-assessment`.** This keeps the platform reusable and the domain replaceable. Enforced by `eslint-plugin-boundaries` in CI, because without enforcement it erodes in weeks — the first time someone wants a case status inside a notification template, the dependency goes in backwards.

### Shared packages

| Package             | Contents                                              | Why separate                                                                  |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `@tas/decimal`      | `Money`, statutory rounding, allocation               | Used by API, worker and tests; the money rules must be one implementation     |
| `@tas/contracts`    | Statuses, enums, roles, case state machine            | Shared with the SPA; prevents drift between layers                            |
| `dynaforms-core`    | Form model, dependency + validation + formula engines | **Framework-agnostic so the server runs the same validation the browser ran** |
| `dynaforms-angular` | Builder and renderer                                  | Angular-specific half of the fork                                             |

---

## 4. Data model

Four schemas in one PostgreSQL database, for clarity and grant separation.

| Schema     | Contents                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `platform` | Users, roles, permissions, menus, delegation, taxpayers, masters, documents, notifications, audit, scheduling, i18n, grids |
| `forms`    | Categories, templates, elements, submissions                                                                               |
| `workflow` | Process registry, snapshots, active tasks, activity progress, SLA tracker                                                  |
| `tax`      | Assessment domain and tax configuration                                                                                    |

Flowable manages its own `flowable` schema through its Liquibase changelogs. **We never write to it directly** — our `workflow.*` tables are a read model fed by webhooks.

### Core domain tables

```
tax_assessment_case ---+--- tax_assessment_period
                       +--- tax_assessment_item --- tax_assessment_adjustment
                       +--- tax_calculation_result --- tax_calculation_trace
                       +--- tax_assessment_evidence      (append-only)
                       +--- tax_assessment_notice --- tax_notice_service
                       +--- tax_assessment_objection --- tax_assessment_appeal
                       +--- tax_assessment_assignment
                       +--- tax_assessment_event         (append-only ledger)
                       +--- tax_assessment_deadline
                       +--- (self) predecessor_case_id   supersession chain

tax_rule_set --- tax_rule_set_item
tax_deadline_config --- tax_assessment_deadline
```

### Integrity rules enforced in the schema

These are in the database, not only in application code, because application code can be bypassed and an assessment has to be defensible years later.

1. **Money is `NUMERIC(20,4)`.** Never float, never double (ADR-007).
2. **`tax_calculation_result` rows are immutable.** Recalculation inserts a new version and flips `is_current` in one transaction.
3. **`tax_assessment_event` and `tax_assessment_evidence` are append-only.** UPDATE and DELETE are revoked from the application role.
4. **Foreign keys are `ON DELETE RESTRICT`.** Assessments are never hard-deleted; `is_active` is the only delete.
5. **One open case** per (taxpayer, tax type, assessment year, version), via a partial unique index excluding cancelled cases.
6. **`legal_hold`** blocks retention-driven deletion regardless of retention class.

### Where JSONB is and is not allowed

| Allowed                                   | Not allowed                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| Form definitions and submissions          | Any monetary amount that is reported, aggregated or recalculated |
| Evidence snapshots (payload as retrieved) | Any statutory date                                               |
| Rule-set item parameters and conditions   | Case status, adjustment lines, calculation results               |
| Event payloads                            | Anything a register query must filter on                         |

**JSONB is the authoring and evidence format; normalised columns are the reporting and computation format.** Adjustments and calculation results are written to both — the submission JSON is what the officer filled in, the normalised rows are what the system computes and reports on.

---

## 5. Request lifecycle

```
1  JWT validated (signature, expiry, audience) against Keycloak's JWKS
2  Request context populated: userId, username, roleCodes, departmentId
3  Route permission checked against the Redis role->route cache
      -> FAIL CLOSED on cache miss or Redis outage
4  DTO validated (class-validator); unknown properties rejected, not stripped
5  Service applies a mandatory record-level scope predicate
6  Domain work, inside a transaction
7  Status change writes exactly one tax_assessment_event, same transaction
8  Response shaped by an interceptor; correlation id on every log line
```

Step 3 fails closed deliberately. An instance that cannot reach Redis cannot authorise anyone, so readiness reports Redis as a hard dependency and the instance is taken out of the load balancer rather than left returning 403 to everyone.

---

## 6. Workflow integration

Flowable owns sequencing, timers and task state. The API owns business meaning.

```
API  --deploy/start-->  Flowable
API  <--webhooks-----   Flowable    (PROCESS_STARTED, TASK_CREATED, ACTIVITY_*)
API  --task/complete->  Flowable
API  <--apiInvoker---   Flowable    (service tasks call back into the API)
```

### Authoring contracts

| Element       | Contract                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| User task     | `flowable:candidateGroups` + `flowable:properties`: `stepCode`, `formId`, `roles`                               |
| Service task  | `${apiInvoker}` with `endpoint`, `method`, `inputExpression`, `outputVariable`, `retryPolicy`, `idempotencyKey` |
| Sequence flow | Condition AST in `flowable:conditionJson`, evaluated via JSON-Logic                                             |
| Action codes  | Derived from the linked form's `ButtonGroup`. The BPMN layer never defines actions                              |
| Business key  | **Always the case number**, so objection and appeal correlate to their parent                                   |

### Hazards handled up front

| Hazard                                                      | Handling                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A role-less user task is open to any authenticated user     | **Publish-time validation rejects it.** Fail closed                                                   |
| Webhooks are fire-and-forget and the read model can diverge | Reconciliation job; **the domain event ledger, not the engine tables, is the audit system of record** |
| `definitionKey` is generated per deployment                 | Never hard-coded; resolved by `workflow_code` through our registry                                    |
| Long-running instances outlive definition versions          | Definition version pinned on the case; migration is explicit                                          |

---

## 7. Calculation pipeline

Nine steps, each a small independently testable class consuming `tax_rule_set_item` rows of its type and emitting trace entries.

```
inputs -> resolve rule set (jurisdiction + tax type + period date)
       -> 1 base determination
       -> 2 loss set-off, ordering, expiry
       -> 3 taxable base and rounding
       -> 4 rate application (flat / slab / minimum tax)
       -> 5 surcharge
       -> 6 credits (WHT, advance, foreign — ordered, capped)
       -> 7 penalty (fixed / percent / greater-of)
       -> 8 interest (rate schedule, day count)
       -> 9 net position
       -> result + trace + ruleSetVersion + inputsHash
```

**The pipeline is pure.** No clock reads, no database reads, no randomness inside the steps: all inputs are resolved before it runs and hashed into `inputs_hash`. Purity is what makes the golden-case regression harness possible and what makes an assessment reproducible in an appeal four years later.

Every step takes and returns `Money`, never `number`.

---

## 8. Audit

| Source                          | Captures                                                |
| ------------------------------- | ------------------------------------------------------- |
| `tax_assessment_event`          | Domain events. **The system of record**                 |
| `entity_history`                | Before/after row snapshots for registered tables        |
| `tax_calculation_trace`         | Every intermediate computation step                     |
| `tax_assessment_evidence`       | Source, parameters, SHA-256 payload hash                |
| `workflow.wf_activity_progress` | BPMN activity trace                                     |
| `notification_history`          | Communication audit                                     |
| `document_access_log`           | Who viewed or downloaded what                           |
| `api_trace_log`                 | API access, with financial and personal fields redacted |
| `export_job`                    | Who exported the register, when, and filtered to what   |

A single **timeline API** merges these at read time. There is no consolidated table — merging at read time avoids a second copy that can disagree with the first.

### Append-only, enforced by the database

`tax_assessment_event` refuses UPDATE and DELETE; `tax_assessment_evidence`
refuses DELETE and permits an UPDATE only when nothing but `is_current`
changes, which is how a re-retrieval supersedes a snapshot.

This is a **trigger**, not a grant. Plan 19.3 calls for revoking UPDATE and
DELETE from the application role, which only works where the application does
not own the tables — and where it does, an owner can re-grant itself anything
it revoked. A trigger applies to the owner, to a superuser session, and to
anybody who reaches the database with psql, which is the property an audit
control needs: the person you are guarding against is the one holding the
credentials. The grants are revoked as well, for deployments that do separate
the roles.

---

## 9. Configuration, not code

The acceptance criterion for "reusable across jurisdictions" is that standing up a second jurisdiction requires **zero lines of code**. It was tested by configuring Saudi Arabia end to end — Friday/Saturday weekend, SAR, flat 20% with no marginal relief, 120-day deadlines, committee forums, 360-day interest. It found exactly one hard-coded assumption, a `?? 'GBP'` currency default, which is what the exercise exists to do.

| Configured                | Mechanism                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| Forms                     | DynaForms JSON templates                                                                                  |
| Process                   | BPMN definitions                                                                                          |
| Tax rules                 | Versioned, effective-dated `tax_rule_set` + `_item`                                                       |
| Deadlines                 | `tax_deadline_config`: anchor event + offset + calendar rule                                              |
| Roles, permissions, menus | Seeded by migration                                                                                       |
| Notifications             | Type + template per channel per language                                                                  |
| Register columns          | `grid_definition` — resolved through a code-side allowlist, so configuration never supplies SQL (ADR-016) |
| Master catalogues         | `master_data` + `master_data_item` — a table per list would mean a migration per jurisdiction             |

### Rule-set governance

1. `DRAFT` -> `PUBLISHED` -> `ARCHIVED`, versioned and effective-dated.
2. Publication requires `TA_ADMIN` **and a second approver** — dual control in production, enforced in code.
3. A case pins the rule-set version it used; recalculation under a newer version creates a new result version and is flagged.
4. Overlapping effective-date ranges for the same (jurisdiction, tax type) are **rejected at publish time**. Ambiguity here is a wrong assessment.
5. A **rule simulator** diffs a draft rule set against historic cases before publication.

---

## 10. Where the risk is

| Risk                                                   | Mitigation                                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Incorrect computation reaches production               | Decimal engine, golden-case gate in CI, rule simulator, dual-control publish, parallel run during pilot                    |
| Platform foundation under-estimated                    | Phase 1 sized explicitly; "minimum Tax Assessment needs" scope rule                                                        |
| Statutory deadline computed wrongly                    | Configurable engine over an explicit holiday calendar; exhaustive boundary tests; never client-side                        |
| Scope creep into a general-purpose platform            | Every foundation component justified against a requirement; ADR required to generalise                                     |
| No payments/ledger system                              | Provider interface with manual-entry fallback; open question Q6                                                            |
| BPMN eventual consistency corrupts audit               | Reconciliation job; event ledger is the record of truth (ADR-009)                                                          |
| An audit trail edited by whoever holds the credentials | Append-only enforced by trigger, not by grant, so it binds the owner too (ADR-013)                                         |
| Configuration becoming an injection route              | A grid definition names a column key; only code maps a key to SQL (ADR-016)                                                |
| An export becoming a bulk-extraction tool              | Every export is an attributable row, carries the requester's scope, and is rate limited                                    |
| Tax content that has not been through an SME           | Rates, penalties, interest and deadlines are data, so a correction is a data change — but they are **not** certified today |
