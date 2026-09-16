# ADR-002: Flowable as the single workflow engine

**Status:** Accepted
**Date:** 2026-10-01
**Plan reference:** V2 sections 2.3, 2.4, 5
**Supersedes:** the dual-track recommendation in the V1 plan section 5.4

## Context

The assessment lifecycle is a long-running, multi-role process with statutory time limits. It needs:

- **Timers that are legally significant** — objection windows, appeal windows, taxpayer response windows, limitation warnings, SLA escalation
- **Message correlation** — objection and appeal are separate processes with independent lifetimes that must correlate back to a parent case
- **Boundary events** — interrupting (escalate an overdue review) and non-interrupting (remind without disturbing)
- **A visual process journey** — for a tax authority this is an audit-defence artefact, not a developer convenience
- **Durable state and crash recovery** — a process instance may live for years

The V1 plan, written against an existing platform that already contained three workflow engines, recommended running the MVP on a simple table-driven step engine and migrating to BPMN at Phase 5.

## Decision

**Flowable 7 from day one. There is no second engine.**

The V1 dual-track recommendation is explicitly withdrawn. It existed only because both engines already existed in that codebase and neither could be deleted. Greenfield, building a second workflow engine in order to migrate away from it later is indefensible: it is two implementations, two sets of bugs, a migration project, and a period where the lifecycle is defined twice.

Flowable runs as its own Spring Boot service. It owns sequencing, timers and task state. It owns **no tax logic, ever**.

### Contracts

| Element       | Contract                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| User task     | `flowable:candidateGroups` plus `flowable:properties`: `stepCode`, `formId`, `roles`                                                          |
| Service task  | `flowable:delegateExpression="${apiInvoker}"` with `endpoint`, `method`, `inputExpression`, `outputVariable`, `retryPolicy`, `idempotencyKey` |
| Sequence flow | Condition AST in `flowable:conditionJson`, evaluated via JSON-Logic                                                                           |
| Business key  | **Always the case number**, so objection and appeal correlate to their parent                                                                 |

### `apiInvoker` is built in Phase 1, not deferred

In the V1 platform, service tasks could only update a status, so calling an arbitrary API from a process was impossible and a generic delegate was deferred to Phase 5. That constraint does not exist here. `apiInvoker` is roughly 300 lines of Java plus a modeler property panel, and without it every system step in the lifecycle has to be faked as an auto-completed user task. It ships in Phase 1.

## Consequences

**Good**

- Statutory timers are engine features rather than cron jobs reinventing them badly.
- Objection and appeal are genuinely separate processes with their own lifetimes.
- The process journey is generated from the definition rather than drawn by hand.
- One definition of the lifecycle, in one place, visually reviewable by non-developers.

**Costs**

- **A Java service in a TypeScript stack.** Accepted deliberately: no Node BPMN library is credible for durable timers and crash recovery, and reimplementing Flowable is not a reasonable use of the budget.
- **Eventual consistency.** Flowable owns its schema; our read model (`workflow.*`) is fed by webhooks and can lag or diverge. Mitigated by a reconciliation job, and by making the **domain event ledger — not the engine's tables — the audit system of record**.
- **Engine-specific BPMN extensions** make the definitions not fully portable to another engine. Accepted; portability between BPMN engines is largely theoretical anyway.

## Hazards handled up front

| Hazard                                                             | Handling                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| A user task with no role rows defaults to "any authenticated user" | **Publish-time validation rejects any process containing a role-less user task.** Fail closed |
| `definitionKey` is generated per deployment                        | Never hard-code one; resolve by `workflow_code` through our own registry                      |
| Long-running instances outlive definition versions                 | Pin the definition version on the case; migrate instances explicitly                          |
| Webhook delivery is fire-and-forget                                | Reconciliation job; alert on divergence                                                       |

## Alternatives considered

**Camunda 8 (Zeebe).** Excellent engine. Rejected on operational footprint — Zeebe plus Elasticsearch plus Operate is heavy for this scale — and because licensing is a customer decision we should not pre-empt.

**A table-driven step engine (the V1 MVP recommendation).** Rejected: no timers, no message correlation, no boundary events, no parallelism. Every one of those is a requirement by Phase 6, so it would be a knowingly temporary build.

**A Node BPMN library.** Not credible for durable timers, persistent state and crash recovery.

## What we kept from the table-driven idea

The **assessment cycle/window** concept — a selection campaign with an effective date range — is genuinely useful. It survives as `tax_assessment_selection_run`, a domain concept rather than an engine feature.

---

## Amendment: Java 17, not 21

**Date:** 2026-10-02

The V2 plan specified Java 21 for the engine service. It is built and tested on
**Java 17**, because Flowable 7 and Spring Boot 3.4 both require only 17 and 17
is the LTS installed on the build machines.

Nothing in the service uses a language feature above 17. Raising the target is
a one-line change in `pom.xml` when a 21 toolchain is standard.

## Status: implemented and verified

The delegate this ADR argued for building in Phase 1 rather than Phase 5 now
exists, with six integration tests against a running engine and an HTTP stub
standing in for the API:

| Behaviour                                                          | Why it matters                                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Calls the configured endpoint and stores the parsed response       | A later gateway can branch on a field of it                                            |
| Sends `Idempotency-Key`, `X-Process-Instance-Id`, `X-Business-Key` | Without the key, a retried `generateNotice` issues a second notice                     |
| Derives a distinct key per process instance                        | Two genuinely different pieces of work must not dedupe against each other              |
| Raises `BpmnError` on 4xx                                          | Permanent: retrying a rejected request gets it rejected again. Routes to a manual task |
| Throws on 5xx                                                      | Transient: Flowable's async executor retries with backoff                              |

The publish-time role check lives in the **API**, not the engine
(`workflow/bpmn-validator.ts`, 22 tests). It is a business rule, it needs to be
testable without a database, and a rejection needs to explain itself to whoever
drew the diagram. It also rejects a service task that names a Java class or an
arbitrary expression: a process definition is configuration, and configuration
must not choose what code runs inside the engine.
