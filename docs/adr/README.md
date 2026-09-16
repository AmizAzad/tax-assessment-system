# Architecture Decision Records

An ADR records a decision that was expensive to make and would be expensive to
reverse. It captures the context and the trade-off, not just the outcome, so
that a future reader can tell whether the reasoning still holds.

## When to write one

Write an ADR when you:

- choose a technology, framework or external service
- change a module boundary or the direction of a dependency
- diverge from upstream in a forked package
- change how money, dates, identity or audit work
- overturn an existing ADR

Do not write one for a library bump, a bug fix, or a decision that is obvious
and cheap to reverse.

## Status values

| Status     | Meaning                                  |
| ---------- | ---------------------------------------- |
| Proposed   | Under discussion                         |
| Accepted   | Decided and binding                      |
| Superseded | Replaced; names the ADR that replaced it |
| Deprecated | No longer applies; nothing replaced it   |

## Index

| ADR                                                           | Title                                                          | Status   |
| ------------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [001](ADR-001-backend-stack.md)                               | NestJS and TypeScript as the primary backend                   | Accepted |
| [002](ADR-002-workflow-engine.md)                             | Flowable as the single workflow engine                         | Accepted |
| [003](ADR-003-identity.md)                                    | Keycloak for authentication; authorisation stays ours          | Accepted |
| [004](ADR-004-monorepo.md)                                    | Monorepo with enforced module boundaries                       | Accepted |
| [005](ADR-005-dynaforms-fork.md)                              | DynaForms forked into this repository                          | Accepted |
| [006](ADR-006-calculation-authority.md)                       | Server-side calculation authority                              | Accepted |
| [007](ADR-007-money-representation.md)                        | Money as an exact decimal type                                 | Accepted |
| [008](ADR-008-jsonb-boundaries.md)                            | Where JSONB is allowed, and where it is not                    | Accepted |
| [009](ADR-009-event-ledger-system-of-record.md)               | The domain event ledger is the audit system of record          | Accepted |
| [010](ADR-010-provider-interfaces.md)                         | External dependencies sit behind provider interfaces           | Accepted |
| [013](ADR-013-append-only-audit-enforcement.md)               | Append-only audit enforced by trigger, not by grant            | Accepted |
| [016](ADR-016-configuration-resolves-through-an-allowlist.md) | Configuration chooses from an allowlist; it never supplies SQL | Accepted |

Numbers are allocated from the plan's list and are never reused, so a gap means
"not yet written" rather than "withdrawn".

Still to write: rule-set versioning and dual-control publication (011),
server-computed statutory deadlines (012), modular monolith and service
extraction criteria (014), fail-closed authorisation (015).

Each of those four records a decision that is **already implemented and
tested** — the ADR is the missing write-up, not a missing decision. Until they
exist, the reasoning lives in the code comments and in
[architecture.md](../architecture.md).
