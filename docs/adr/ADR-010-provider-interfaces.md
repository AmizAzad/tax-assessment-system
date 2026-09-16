# ADR-010: External dependencies sit behind provider interfaces

**Status:** Accepted
**Date:** 2026-10-02
**Plan reference:** V2 sections 6.3, 17.1, 17.2, 17.3, 20

Cited from `apps/api/src/platform/document/document-storage.ts`.

## Context

An assessment depends on things this system does not own: filed returns, bank
data, a withholding register, a payments ledger, object storage, e-mail, an
SMS gateway, a signing service. Each has its own availability, its own
authentication, and its own idea of what a date looks like.

Two failure modes follow from wiring them in directly.

The first is **coupling**. A calculation that reads an S3 SDK type, or an
evidence service that knows an external API's JSON shape, cannot be tested
without that dependency and cannot be moved to a different provider without
touching the domain.

The second, and worse: **a third party's outage becomes a tax outcome**. If a
bank feed is unreachable and the code treats "no data" as "no income", the
system assesses on a figure that nobody supplied.

## Decision

**Every external dependency is reached through a narrow interface owned by
this system, and the domain depends only on that interface. Absence is always
represented explicitly, never as an empty value.**

### The shape

```ts
export interface EvidenceProvider {
  readonly code: string;
  readonly mandatory: boolean;
  retrieve(request: EvidenceRequest): Promise<EvidencePayload>;
}
```

The domain asks for evidence. It does not know whether the answer came from a
table, an HTTP call or a file drop. Providers are registered under a token and
fanned out over; adding one is a module registration, not a change to the
evidence service.

Object storage is the same pattern, deliberately narrow: put, get, sign,
delete. Four operations. A richer interface would leak the provider's
capabilities into the callers, and then the provider could not be replaced.

### Absence is a value, not an empty result

A provider that fails returns an outcome saying so. The evidence service
records the failure, and **a failed mandatory source blocks `DATA_READY`** —
the case does not proceed to assessment on partial data. A missing optional
source is recorded and the case continues.

This is the rule the whole ADR exists for. The alternative — treating an
unreachable source as a zero — produces an assessment that is wrong in the
taxpayer's disfavour, defended on evidence that was never retrieved.

### What crosses the boundary

| Crosses                                  | Does not cross                          |
| ---------------------------------------- | --------------------------------------- |
| Our own request and payload types        | The provider's SDK types                |
| Monetary values as exact decimal strings | Provider-native numbers                 |
| ISO-8601 instants                        | Locale-formatted dates                  |
| A payload hash, computed on capture      | Anything unhashed that we later rely on |

### Reliability is the port's business, not the caller's

Timeouts, retries with backoff, circuit breaking and idempotency keys live in
the adapter. A domain service never writes a retry loop, because a retry loop
in a domain service is a retry loop nobody tested and one that will eventually
double-apply something.

## Current state, stated plainly

Both evidence providers implemented today — the filing store and the taxpayer
account — read **our own tables**. No live bank feed, withholding register or
third-party integration exists. The port is real and is fanned out over; it has
not yet been proved against a provider that can be slow, wrong or down.

That is a gap rather than a completed decision, and it is recorded in the
README's outstanding list for the same reason it is recorded here: the pattern
is only worth what its first real integration proves it is worth.

## Consequences

**Good**

- Evidence retrieval, document storage and notification dispatch are unit
  testable with a fake, without Docker.
- A provider swap is one adapter.
- An outage degrades the case to "cannot proceed" rather than to "assessed on
  nothing".

**Costs**

- An interface per dependency, and a mapping layer that is pure overhead until
  the second provider exists.
- The narrow storage interface means anything clever a specific provider offers
  is unavailable without widening it deliberately.
- Fan-out makes retrieval as slow as the slowest mandatory source.

## Related

- ADR-006 — the calculation pipeline is pure; providers resolve before it runs
- ADR-009 — a retrieval, successful or not, is an event in the ledger
- ADR-007 — amounts cross the boundary as strings, never as provider numbers
