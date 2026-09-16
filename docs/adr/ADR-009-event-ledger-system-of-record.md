# ADR-009: The domain event ledger is the audit system of record

**Status:** Accepted
**Date:** 2026-10-02
**Plan reference:** V2 sections 8.2, 10.2, 16.2, 19.1, 19.2

Cited from `apps/api/src/tax-assessment/case/case.service.ts`.

## Context

Six things in this system record what happened to a case:

| Source                       | What it holds                              |
| ---------------------------- | ------------------------------------------ |
| `tax_assessment_event`       | Domain events: who moved the case, and why |
| `entity_history`             | Before/after row snapshots                 |
| `workflow.activity_progress` | What the BPMN engine did                   |
| `workflow.active_task`       | Which tasks are open                       |
| `notification_history`       | What was sent to whom                      |
| `document_access_log`        | Who read which document                    |

They will disagree. Not through carelessness — through mechanics. The engine
reports asynchronously over a webhook, so `activity_progress` lags and can miss
an event if the webhook fails. `entity_history` records that a column changed
but not the reason. A notification can be queued and never delivered.

In a dispute, somebody has to answer "what happened to this assessment, and on
whose authority". Six sources with six answers is not an audit trail.

## Decision

**`tax_assessment_event` is the system of record. Everything else is
corroboration, and may lag or be incomplete without the record being wrong.**

Three rules make that true rather than aspirational:

### 1. The event is written in the same transaction as the change

A status change and its ledger entry succeed or fail together:

```ts
await this.sequelize.transaction(async (t) => {
  await this.applyTransition(t, caseId, action);
  await this.writeEvent(t, caseId, eventType, fromStatus, toStatus, caller);
});
```

There is no path that moves a case without writing an event, because moving a
case goes through one method and that method writes the event. If the event
insert fails, the transition is rolled back and the case did not move.

### 2. The workflow tables are a read model and may lag

The engine's view is downstream. A case whose `activity_progress` is behind is
not a case in an unknown state — the ledger says where it is. The
reconciliation report exists to surface divergence between the two, and every
divergence it finds is resolved in favour of the ledger.

This is the other half of ADR-002: the engine coordinates, the API decides.

### 3. The ledger is append-only, enforced by the database

See ADR-013. A record that can be edited by whoever holds the credentials is
not a record.

## What an event must carry

| Field                      | Why                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `case_id`, `event_type`    | What happened, to what                                                                     |
| `from_status`, `to_status` | The movement, so the sequence is reconstructible without joins                             |
| `actor_user_id`            | Who. Never inferred later from an assignment table                                         |
| `actor_role_code`          | **In what capacity** — the same person may be assessor on one case and reviewer on another |
| `occurred_at`              | From the database clock, never the application server's                                    |
| `payload_json`             | The reason, the amounts quoted, the justification text                                     |

`actor_role_code` is what makes segregation of duties auditable after the
fact: "this person reviewed their own work" is a question about capacity, not
about identity.

## Consequences

**Good**

- One answer to "what happened", available without the engine running.
- The timeline API merges all six sources at read time, with the ledger as the
  spine. No consolidated table to drift from its own inputs.
- A failed webhook degrades corroboration, never the record.

**Costs**

- Every state-changing service method must take the caller explicitly and pass
  it down to `writeEvent`. That is deliberate friction: a service that could
  write an event without an actor would eventually write one.
- The ledger grows without bound. It is partitioned by date when volume
  requires it; it is never pruned while a case is within its retention class
  or under legal hold.
- Reading the whole history of a long-running case is a scan. Indexed on
  `(case_id, occurred_at)`; the cost is accepted.

## Related

- ADR-002 — the engine coordinates; the API owns status
- ADR-013 — append-only enforcement at the database
- ADR-006 — calculation traces are a parallel record, pinned to a rule set
