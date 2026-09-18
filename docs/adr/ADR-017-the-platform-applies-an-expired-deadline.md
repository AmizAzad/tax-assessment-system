# ADR-017: The platform applies an expired deadline to the case

**Status:** Accepted
**Date:** 2026-10-11
**Plan reference:** V2 sections 10.2, 10.5, 12.6, 16.1

## Context

Three transitions have been in the state machine since the table was written
and nothing has ever emitted them:

| From                | Action               | To               | Actor  |
| ------------------- | -------------------- | ---------------- | ------ |
| `AWAITING_TAXPAYER` | `TIMEOUT`            | `IN_PREPARATION` | SYSTEM |
| `INITIATED`         | `LIMITATION_EXPIRED` | `TIME_BARRED`    | SYSTEM |
| `IN_PREPARATION`    | `LIMITATION_EXPIRED` | `TIME_BARRED`    | SYSTEM |

The two `LIMITATION_EXPIRED` transitions were unemitted on purpose. The
deadline sweep in `apps/api/src/tax-assessment/deadline/deadline.scheduler.ts`
marked a passed limitation deadline `BREACHED`, wrote a warning, and stopped
there, under a comment that said so:

> Flagged, never applied. Whether a case is genuinely time barred can turn on
> facts the platform does not hold.

That refusal has a real argument behind it. A limitation period can be
suspended by agreement with the taxpayer, extended by a fraud or negligence
finding, or restarted by an event recorded on paper in another office. None of
those are in this database. A scheduler that time-barred a case on an
incomplete record would extinguish the authority's right to collect a debt that
was in fact still collectible, and `TIME_BARRED` is terminal: `assertTransition`
refuses every action out of it, so there is no route back through the API.

The `TIMEOUT` transition was never emitted for a duller reason. Nothing
implemented it. A case sat in `AWAITING_TAXPAYER` until an officer moved it by
hand, and the `RESPONSE` deadline configuration that exists for GB and SA
(`tax.tax_deadline_config`, anchored on `INFO_REQUESTED`) had no code reading
it.

## Decision

**The platform now applies both consequences. The user has decided to reverse
the documented refusal on time-barring, having been told what it costs: a case
the platform time-bars on an incomplete record is a debt the authority can no
longer collect, and `TIME_BARRED` is terminal with no transition back.** We
reject the previous position that the risk makes the behaviour inadmissible,
and we reject the alternative of a discretionary queue for an officer to
confirm each expiry, because a queue nobody works is the same missed limitation
period with an extra screen. What we keep from the old position is that the
platform must never be able to time-bar a case whose record is knowingly
incomplete, and that is what the bounds below are for. The decision is reversed
under four bounds, every one of which must hold before a case is time-barred,
and it is off by default so that no existing deployment acquires the behaviour
by taking a release.

### The bounds on time-barring

1. **Only from `INITIATED` and `IN_PREPARATION`.** The sweep reads the
   permitted origins from `statusesWithAction('LIMITATION_EXPIRED')` rather
   than restating them in SQL, so the transition table stays the single
   statement of where this is legal. A case under objection, under appeal or
   already finalised is never a candidate, because the table does not declare
   it.
2. **Never under a legal hold.** `tax_assessment_case.legal_hold` is the flag
   an officer sets when a case is known to be subject to something the platform
   does not model. It already blocks retention-driven deletion. A held case is
   precisely the case whose record we have been told is incomplete, so it is
   the one case the sweep must not touch.
3. **Off unless configured on.** `TIME_BAR_ON_LIMITATION_EXPIRY` defaults to
   `false`, following `SCHEDULER_ENABLED`. An authority turns this on when its
   limitation rules are genuinely unconditional; until then the old behaviour
   is what runs.
4. **Only against a materialised `LIMITATION` deadline row.** The sweep acts on
   a breached deadline, not on `tax_assessment_case.limitation_date`. No
   jurisdiction shipped today configures a `LIMITATION` deadline type, so
   enabling the flag on a stock deployment still time-bars nothing. Configuring
   a limitation period is the second, deliberate act that arms this.

The warning log stays. A time-barred case is still the thing an officer will
later be asked to explain, and the log line is where the explanation starts.
The event written to the ledger carries `appliedBy: 'PLATFORM'` and the job
code, so the register can always distinguish a case an officer closed from one
the scheduler closed.

### The information-request timeout belongs to the engine

`AWAITING_TAXPAYER -> TIMEOUT -> IN_PREPARATION` is modelled in
`db/bpmn/TAX_ASSESSMENT_MAIN.bpmn20.xml` as a boundary timer on a waiting task,
the same shape the objection window already uses, and not as a second scheduler
sweep. Deciding who waits and for how long is what ADR-002 gives the engine.
The timer's date comes from the `RESPONSE` deadline row materialised when the
information request is made, so the wait is the configured statutory period for
the jurisdiction and not a constant in a diagram.

A timeout is also a much smaller act than a time-bar. It returns the case to
the officer who asked the question. Nothing is extinguished, so it needs no
flag and no bounds beyond the transition table.

## Consequences

**Good**

- A limitation period can no longer pass unnoticed because nobody opened the
  case that day, which is the failure the deadline table exists to prevent.
- `TIME_BARRED` becomes reachable in the product, not just in the table. The
  structural reachability test in `transitions.spec.ts` was asserting something
  the running system could not do.
- An information request no longer parks a case indefinitely. The engine returns
  it to the assessor when the configured response period lapses.
- Both sweeps converge rather than repeat. A time-barred case leaves the
  candidate set, and a terminal status is refused by `assertTransition` anyway,
  so a second pass over the same case is a no-op rather than a duplicate event.

**Costs**

- An authority that turns the flag on with an incorrectly configured limitation
  period will terminate collectable cases, and the route back is a new case
  rather than a transition. This is the cost the user accepted.
- The bounds are four separate things to get right, and three of them are
  invisible in the sweep's SQL until you read the transition table alongside it.
- The engine now has a wait state it did not have. A case whose process
  instance was never created, because the engine was unreachable when the case
  was opened, gets no timeout. That case was already being worked by hand.

## Related

- ADR-002 — the engine owns coordination, which is why the timeout is a
  boundary timer and the time-bar is not
- ADR-009 — the ledger records that the platform, not a person, applied the
  transition
- ADR-013 — the event is written, never updated, so an automatic time-bar
  cannot be quietly relabelled later
