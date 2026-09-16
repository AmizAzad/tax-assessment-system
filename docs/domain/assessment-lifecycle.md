# The assessment lifecycle

How a tax assessment case moves from "we think something is wrong" to a figure
the authority can defend. Implemented in Phases 2–4; this document describes
what is built, not what is planned.

Plan reference: V2 sections 8–11.

---

## The governing rule, restated

> Forms display. The server decides. Nothing that determines a legal figure or
> a statutory date may execute in a browser.

Everything below follows from that. The browser shows a case; it never decides
one.

---

## The states

```
                    INITIATED
                        |  RETRIEVE_DATA  (SYSTEM)
                    DATA_READY
                        |  ASSIGN         (supervisor)
                     ASSIGNED
                        |  START          (assessor)
                 IN_PREPARATION <-----------------+
                        |  CALCULATE      (assessor)
                    CALCULATED             REVIEW_RETURNED
                        |  SUBMIT          (assessor)  |
                   UNDER_REVIEW ---- RETURN -----------+
                        |  ACCEPT         (reviewer)
                     REVIEWED
                        |  ROUTE_APPROVAL (SYSTEM)
                  PENDING_APPROVAL
                        |  APPROVE        (approver)   REJECT -> REJECTED
                     APPROVED
                        |  FINALISE       (SYSTEM)
                    FINALISED
```

Beyond finalisation the machine continues into notices, objections, appeals,
reassessment, settlement and closure. All of it is built: the states are in
`@tas/contracts`, and the services behind them — notice generation and service,
objection admissibility and decision, appeal hearings and implementation,
reassessment in place or as a successor, settlement derived from payments, and
closure with a frozen balance — are implemented and exercised end to end.

The table itself lives in [`packages/contracts/src/transitions.ts`](../../packages/contracts/src/transitions.ts)
as data, not as a `switch`. That is what lets a structural test assert
properties over the whole machine — one such test found two terminal states
that no transition could reach, which was a gap in the plan rather than in the
code.

### Why some transitions are SYSTEM-only

`RETRIEVE_DATA`, `ROUTE_APPROVAL` and `FINALISE` name `SYSTEM` as their only
actor. No human role holds them, and that is deliberate:

| Transition       | Why nobody may perform it directly                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `RETRIEVE_DATA`  | `DATA_READY` asserts that the data actually arrived. A button that sets it makes the status a claim rather than a fact.            |
| `ROUTE_APPROVAL` | Routing follows the amount and the delegation limits. If a person chose, they could route their own case to a friendlier approver. |
| `FINALISE`       | Follows from an approval already recorded. Nothing else should be able to make figures legally binding.                            |

A person still _asks_ for each step through a permissioned endpoint. What they
cannot do is choose its outcome.

---

## Evidence

An assessment is a legal act taken on a set of facts at a point in time. If the
facts can shift underneath the case, the figure a reviewer approves is not
necessarily the figure the assessor computed, and neither can be defended.

So evidence retrieval is an explicit, recorded, hashed event.

### The provider contract

Sources sit behind [`EvidenceProvider`](../../apps/api/src/tax-assessment/evidence/evidence-provider.ts).
Two are implemented: the filing store and the taxpayer account. Both are
**mandatory**.

The central rule:

> A provider returns facts, or it throws. It must never return zero, an empty
> list, or a default to signal "I could not reach the source."

A zero credit and an unreachable credit register are different situations. The
first produces a correct assessment; the second produces a wrong one that looks
correct. `EvidenceService` records a failed provider and **refuses to advance
the case**, which only works because providers are honest about failure.

### How a return becomes tax concepts

The filing provider does not know what a corporation tax return looks like. It
walks the form template, finds elements carrying a `taxConcept`, and reads the
matching `jsonKey` from the submission:

```jsonc
{
  "jsonKey": "tradingProfit",
  "fieldType": 11, // FieldType.NUMBER
  "taxConcept": "TRADING_PROFIT", // <- the only thing linking form to tax
}
```

A new form version can move a figure to a different field without a code
change. Two fields claiming the same concept is refused rather than resolved,
because silently doubling a figure is worse than stopping.

A field with a concept but no value in the submission is **skipped, not read as
zero**: an unanswered question and a declared nil are different claims, and only
the second should reduce an assessment.

### Freezing

Once a case reaches `UNDER_REVIEW`, evidence refresh returns 400. The reviewer
must decide on the facts the assessment was prepared from.

---

## Calculation

Pure. [`calculate(inputs, ruleSet)`](../../apps/api/src/tax-assessment/calculation/pipeline.ts)
touches nothing external — no clock, no database, no configuration lookup. Every
input is resolved before it runs, which is what makes the 39 golden cases
meaningful.

### The nine steps

| #   | Step                 | Note                                                                             |
| --- | -------------------- | -------------------------------------------------------------------------------- |
| 1   | `BASE_DETERMINATION` | Declared figures plus signed adjustments                                         |
| 2   | `LOSS_SET_OFF`       | Oldest first, so a time-limited loss is not stranded                             |
| 3   | `TAXABLE_BASE`       | Rounding applied **here**, once, with an explicit rule                           |
| 4   | `RATE_APPLICATION`   | Bands, and marginal relief where it applies                                      |
| 5   | `SURCHARGE`          |                                                                                  |
| 6   | `CREDITS`            | Non-refundable credits cannot create a repayment                                 |
| 7   | `PENALTY`            | Fixed, percentage, or greater-of                                                 |
| 8   | `INTEREST`           | Simple; **throws** rather than silently computing simple when asked for compound |
| 9   | `NET_POSITION`       |                                                                                  |

### Why UK CIT cannot be modelled as bands alone

Marginal relief is a function of the _whole_ profit, not of the slice above a
threshold:

```
MR = (250,000 − profit) × 3 ⁄ 200
```

A slab model gives the wrong answer for every profit between the limits. The
fraction 3/200 is chosen so the effective rate is continuous at both ends, and
a golden-case test asserts exactly that: £50,000 and £250,000 each produce
identical tax whichever path computes them.

### The trace

Every step emits an entry with the arithmetic written out:

```
4. [RATE_APPLICATION] (250000 - 170000) x 0.015 = 1200 relief; 42500 - 1200 = 41300
```

A reviewer must be able to check the figure by hand. A trace that says
"marginal relief applied" would fail that test; one that shows the arithmetic
passes it.

---

## Deadlines

Statutory dates decide whether a penalty arises, so they are server-side and
configuration-driven. `tax.tax_deadline_config` holds the anchor event, the
offset, an optional secondary offset, and the calendar rule.

The secondary offset exists because the UK corporation tax payment date is
**nine months and one day** after the period end. Rounding that to nine months
would charge every taxpayer an extra day of interest; hard-coding the extra day
in the engine would put a UK rule inside jurisdiction-neutral code.

Dates are handled as plain `YYYY-MM-DD` values in UTC, never as instants. A
statutory deadline is a calendar date, and a local-time `Date` would shift it by
a day for a server west of Greenwich — showing a return filed on the due date as
one day late. A test pins this across three timezones.

Month arithmetic clamps: 31 January plus one month is 28 or 29 February, not
3 March.

---

## Controls

These are the properties that make the output defensible. Each is enforced in
code and verified.

| Control                       | Where                                   | What it refuses                                                                                                                                                                                               |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Segregation of duties**     | `CaseService.assertSegregationOfDuties` | The same person acting as both preparer and reviewer. Checked against _prior participation_, not current assignment — "did this person already act in an incompatible capacity", not "are they assigned now". |
| **Fail-closed identity**      | same                                    | An unattributable caller reaching a barred transition. Earlier this returned early, which switched the control off precisely when it mattered.                                                                |
| **Explicit caller**           | throughout                              | Authorisation decisions take the caller as an argument, never from `AsyncLocalStorage`. The ambient store is for audit attribution and correlation only.                                                      |
| **Dual control on rule sets** | `RuleSetService.publish`                | The author publishing their own rule set. A wrong rate affects every case computed after it.                                                                                                                  |
| **Delegation limits**         | `ApprovalService.bandFor`               | An amount with no configured band. Falling back to the most senior approver would hide a configuration gap behind a behaviour nobody chose.                                                                   |
| **Loss double-relief**        | `ApprovalService.consumeLosses`         | Two cases relieving the same loss. Consumption happens under `FOR UPDATE` in the finalisation transaction.                                                                                                    |
| **Frozen determinations**     | `CalculationService`                    | Recomputing a finalised case. Raise a reassessment instead.                                                                                                                                                   |
| **Duplicate payments**        | partial unique index                    | The same source reference credited twice.                                                                                                                                                                     |
| **Exact money**               | `Money`, `NUMERIC(20,4)`, lint rule     | Arithmetic operators on amounts; JSON numbers in monetary request fields.                                                                                                                                     |

---

## What the database refuses to represent

Some rules are better as constraints than as checks, because a constraint
cannot be forgotten by a new code path:

```sql
-- Two published rule sets covering the same period
ALTER TABLE tax.tax_rule_set ADD CONSTRAINT tax_rule_set_no_overlap
  EXCLUDE USING gist (jurisdiction_code WITH =, tax_type_code WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&)
  WHERE (status = 'PUBLISHED' AND is_active);

-- Two approval bands covering the same amount
ALTER TABLE tax.tax_approval_threshold ADD CONSTRAINT tax_approval_threshold_no_overlap
  EXCLUDE USING gist (jurisdiction_code WITH =, tax_type_code WITH =,
    numrange(amount_from, amount_to, '[)') WITH &&) WHERE (is_active);

-- More than one current calculation per case
CREATE UNIQUE INDEX ux_calculation_current
  ON tax.tax_calculation_result (case_id) WHERE is_current;

-- Consuming more loss than arose
ALTER TABLE tax.taxpayer_loss ADD CONSTRAINT loss_consumed_within_original
  CHECK (consumed_amount >= 0 AND consumed_amount <= original_amount);
```

---

## Error semantics

Domain errors map to statuses rather than surfacing as 500s, so a client can
tell a refusal from a fault:

| Error                                                      | Status | Meaning                                                  |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------- |
| `UnauthorisedTransitionError`                              | 403    | Authenticated, but your role may not do this             |
| `InvalidTransitionError`                                   | 409    | Well-formed, but conflicts with the case's current state |
| `CalculationError` (`NO_EFFECTIVE_RULE`, `AMBIGUOUS_RULE`) | 409    | Configuration conflict; an administrator must resolve it |
| `CalculationError` (other)                                 | 400    | Cannot be satisfied as asked                             |
| `CurrencyMismatchError`, `InvalidMoneyError`               | 400    |                                                          |

The mapping is split across two filters. `CalculationError` belongs to the
assessment domain, and the platform may not import from it (plan 14.2), so the
domain registers its own filter. The boundary lint rule caught this when it was
first written the wrong way.

---

## Sources and their status

UK CIT FY2024 rates, penalties, interest and deadlines were established from
public guidance, not from a subscription legislative service. **They carry an
SME sign-off caveat.** They are seeded as configuration, so correcting one is a
data change rather than a deployment — which is the point of modelling them as
data.

## Notices and service

An assessment binds nobody until it is served. Producing and serving the notice
is therefore its own pipeline, with its own failure modes.

### The pipeline

Resolve the wording, gather the facts **from the approved calculation**,
substitute, hash, render a PDF, store it, record the notice, move the case. A
notice is never computed fresh: it states the figure an approver signed off, and
recomputing at notice time could demand a sum nobody approved.

### The template language does nothing

Substitution only. No arithmetic, no branching, no function calls. A template
that could compute could contradict the calculation, so `{{netPayable + 1}}` is
refused at render time and at publish time, along with any token the system does
not supply.

A missing value is fatal. A notice served with a visible `{{placeholder}}` is a
defect delivered to a member of the public.

### Verification hashes content, not bytes

A PDF embeds a creation timestamp, so two renders of the same notice differ byte
for byte. Hashing the PDF would report every re-render as tampering. The hash is
over the canonical content, which answers the question that matters: _does this
notice still say what it said when it was served?_

### Service is per attempt

|                   |                                                   |
| ----------------- | ------------------------------------------------- |
| One notice        | Many service attempts                             |
| Each attempt      | Its own channel, addressee, proof and outcome     |
| Deemed service    | Per channel, per jurisdiction, from configuration |
| The notice's date | The **earliest** successful attempt               |

Earliest, not latest: a later date would extend the taxpayer's objection window
beyond what the law allows, and where two channels disagree the earlier reading
is also the one that favours the taxpayer.

Actual delivery can pull the deemed date **earlier** where the jurisdiction
allows it, never later. A letter that arrives late was still deemed served on
the statutory date.

If every attempt fails, the notice reverts to unserved and the objection
deadline is re-anchored. A deadline that stayed put after the service date moved
would tell both the taxpayer and the officer that the window closes on a day the
law does not support.

---

## The working calendar

`BUSINESS_DAYS` and `NEXT_BUSINESS_DAY` read `platform.holiday` and the
jurisdiction's `WEEKEND_DAYS` master data.

The weekend is configuration because it is not Saturday and Sunday everywhere.
A platform that assumed the western working week would compute every deadline in
a Sunday-to-Thursday jurisdiction wrongly, and nothing about the arithmetic
would look broken.

Deadlines roll **forward** off a non-working day, never back: moving a deadline
earlier than the statute allows shortens the taxpayer's time, which is the error
that causes harm.

---

## Disputes

### Lateness is computed; admissibility is decided

Deliberately separate. Whether an objection arrived after the deadline is
arithmetic, and the platform does it. Whether a late objection should
nonetheless be heard is a discretion the law grants to a person.

A late objection is therefore **accepted**, recorded as out of time with the
number of days, and put in front of an officer who must decide and say why.
Silently rejecting it would remove a discretion the law grants.

### Nobody rules on their own work

Checked against recorded participation, the same source segregation of duties
uses. An officer who prepared or reviewed the assessment cannot decide the
objection against it, and the permission grants were narrowed to match the
transition table when the two disagreed.

### An appeal is not the authority's decision

A forum outside the authority decides it. The platform records what was held and
then gives effect to it, which is why there is no "approve" on an appeal — only
`recordOutcome`, and the officer doing it is transcribing.

Implementation is tracked separately from the outcome, because _an appeal won
and never implemented_ is the failure that matters: the taxpayer holds a
judgment and the register still shows the old figure.

---

## Reassessment and closure

### Two shapes, chosen by the case's state

| Situation                     | Shape              | Why                                                                              |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| Dispute outcome               | **In place**       | The tribunal varied _this_ assessment; the revised figure is a new version of it |
| New information after closure | **Successor case** | The original was a completed legal act. It is not reopened, it is succeeded      |

The caller does not choose. The status decides, because the status determines
which of the two is legally available.

### Reassessment releases before it consumes

A case can be finalised more than once. The superseded calculation's loss usage
is released first, or the case double-counts against its own earlier self — and
no in-place reassessment involving losses could ever be finalised.

### Settlement is evaluated, never asserted

Nobody presses "settled". The platform compares what was assessed with what has
been received. A button would let a case be marked paid without the money, which
is the single most damaging false record a revenue system can hold.

### Closure freezes the position

`status_code = 'CLOSED'` says a case is over. It does not say why, who decided,
what the balance was, or when the file may be destroyed — the questions asked
years later, usually by someone holding a complaint. The balance is snapshotted
rather than recomputed, because the file must say what it said at the time.

A **legal hold outranks the retention date**. A case under litigation survives
its own destruction schedule, and disposal produces a _list_ rather than
deleting anything: destroying a tax file is irreversible and belongs to a
records officer, not a timer.

---

## Adding a jurisdiction

The plan's central claim is that a new jurisdiction is configuration and **zero
lines of code**. Saudi Arabia was configured to test it, chosen for the
differences most likely to expose a hard-coded assumption:

|                     | GB                             | SA                            |
| ------------------- | ------------------------------ | ----------------------------- |
| Weekend             | Saturday, Sunday               | **Friday, Saturday**          |
| Currency            | GBP                            | **SAR**                       |
| Rate shape          | Two bands with marginal relief | **Flat 20%, no relief**       |
| Filing deadline     | 12 months after period end     | **120 days after period end** |
| Payment deadline    | 9 months and 1 day             | **Same as filing**            |
| Objection window    | 30 days                        | **60 days**                   |
| Late filing penalty | Fixed, then percentage         | **Percentage of tax, capped** |
| Appeal forums       | Tribunals and courts           | **Committees**                |
| Interest day count  | 365                            | **360**                       |

It assesses correctly. The same `applyProgressiveBands` step handles a flat rate
with no flag, and the same pipeline produces an SAR trace.

The exercise found **one** hard-coded assumption: case creation defaulted the
currency to `'GBP'` rather than reading it from the rule set, so every case in a
second jurisdiction opened in the wrong currency and nothing downstream looked
broken. That is precisely what a second-jurisdiction test is for.

---

## Coordination, and where a case has reached

The case machine above owns **status**. The BPMN process owns **who is asked to
act next**. They are different questions, and the system answers them
separately on purpose (ADR-002).

`GET /processes/cases/:id/journey` answers the second: the definition the case
is running under, the activities that have finished, the ones waiting now, and
the engine's own event stream behind both. The workbench draws it as the
diagram with the current step marked.

Three things are worth knowing about it:

**A case with no process is normal.** Orchestration never fails a case. One
opened while the engine was unreachable answers `coordinated: false`, is worked
by hand, and every action on it is recorded identically. The reconciliation
report lists cases in that position; the screen says so rather than showing an
error.

**Active is derived, not stored.** The engine reports when an activity starts
and when it ends. A separate "currently active" list would be a third copy of a
fact the event stream already carries, and the copy is what goes stale when an
event is missed. An activity that has run twice — a rework loop — shows as
active, because the current state is what the reader wants.

**A case keeps the definition it started under.** Deploying a new version
changes what newly opened cases do; a case from last month still draws on the
diagram it actually ran. A journey drawn on the wrong diagram puts the marker
on the wrong box, which is worse than no diagram.

---

## Reporting

Every monetary figure is returned as a string. A report that summed in
JavaScript numbers would disagree with the assessments it reports on, and a
management pack that does not tie back to the register is worse than none.

`GET /reports/reconciliation` lists places where the register contradicts
itself — orphan calculations, loss consumption that does not match its
utilisation rows, cases settled with a balance, assessments finalised but never
notified. Every row is a defect, not a metric. **Empty is the expected answer.**

### Reports answer about the register; the dashboard answers about you

A report is unscoped by design: scoping "how much was assessed this year" to
the caller's own cases makes every total wrong. Access is controlled at the
route instead, and the reporting routes are granted to oversight roles rather
than to caseworkers.

The dashboard is the opposite. "What needs my attention today" is a question
about the caller, so it carries the same scope predicate the register does,
from the same function. A supervisor and an assessor see different numbers on
the same screen and both are right — which is why the screen says whose figures
they are.

Two things the dashboard will not do: it never adds assessed to collected, and
it never treats an internal service level as equivalent to a statutory
deadline. Missing the first is a management problem; missing the second can
make an assessment unenforceable.

### Taking the register away

An export is a copy of taxpayer financial data leaving the system, so it is a
recorded act: every export is a row naming who asked, when, and with which
filters — including the small ones that come back instantly. It carries the
scope of the officer who requested it and only they can collect it.

Amounts are written as text. Excel will not sum the column without a
conversion, and that is the trade: an export that ties back to the notice is
worth more than one that adds up to nearly the right number.

---

## See also

- [ADR-006 — calculation authority](../adr/ADR-006-calculation-authority.md)
- [ADR-007 — money representation](../adr/ADR-007-money-representation.md)
- [ADR-009 — the event ledger is the system of record](../adr/ADR-009-event-ledger-system-of-record.md)
- [ADR-010 — provider interfaces](../adr/ADR-010-provider-interfaces.md)
- [ADR-013 — append-only audit enforcement](../adr/ADR-013-append-only-audit-enforcement.md)
- [Running locally §12](../running-locally.md#12-walk-a-complete-assessment) — the lifecycle as runnable commands
- [Glossary](glossary.md)
- [Running locally, section 12](../running-locally.md#12-walk-a-complete-assessment)
