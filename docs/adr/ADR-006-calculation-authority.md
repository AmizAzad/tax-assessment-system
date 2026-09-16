# ADR-006: Server-side calculation authority

**Status:** Accepted
**Date:** 2026-10-01
**Plan reference:** V2 sections 1.2, 4.4, 14.4

## Context

DynaForms includes a formula engine. Forms can compute. The obvious cheap
design is to let the assessment worksheet compute the tax the way a spreadsheet
would.

The inherited formula engine supports arithmetic with precedence, percentage
fields, currency propagation, date arithmetic, ordered formula-selection rules
and table aggregates. It does **not** support `SUM`, `ROUND`, `MIN`, `MAX`,
`IF`, any function-call syntax, ternaries, boolean operators, modulo, or
arrays. It is floating-point.

Because we forked DynaForms (ADR-005), we could add the missing functions.

## Decision

**The server is the sole authority for every legal figure. The form formula
engine is for on-screen assistance and cross-checks only — and it stays that
way even though we could make it more capable.**

> Forms display. The server decides.

The same rule applies to statutory dates: **deadlines are never computed in the
browser.** A form displays a server-supplied deadline; admissibility is decided
server-side against the stored service date.

### Why not simply extend the formula engine

Expressiveness was never the real problem. Three reasons that adding `IF` and
`ROUND` would not fix:

1. **Floating point.** Even with functions added, the engine computes in JS
   doubles. Making it decimal-exact means rewriting its evaluator — and we
   would then have two decimal engines that must agree forever.

2. **Auditability.** A legal figure must carry a stored trace naming the
   rule-set version that produced it. A formula embedded in a form definition
   has no version, no effective date and no trace. Four years later, in an
   appeal, "which formula produced this number" must have an answer.

3. **Trust boundary.** Anything evaluated in the renderer is, in principle,
   attacker-controlled. A tax liability cannot be.

### What the formula engine is still for

Immediate feedback while an officer types, and **cross-checks that surface
disagreement** between the client estimate and the server result. We will add
`ROUND` / `MIN` / `MAX` / `IF` purely to make those cross-checks more
expressive.

## Non-negotiable rules for calculation

1. Server-side only; the renderer never computes the legal figure.
2. Exact decimal arithmetic throughout (ADR-007). Never floating point.
3. Every run stores an explainable trace, step by step.
4. Rule sets are versioned and effective-dated; a case pins the version it used.
5. Recalculation is idempotent and produces a **new versioned result**, never an
   overwrite.
6. The pipeline is **pure**: no clock reads, no database reads, no randomness
   inside the steps. All inputs are resolved before it runs and hashed into
   `inputs_hash`.

Rule 6 is what makes the golden-case regression harness possible, and what
makes an assessment reproducible years later.

## Consequences

**Good**

- One authoritative implementation, decimal-exact, versioned and traced.
- A rate change is a configuration change, provably safe via the golden-case
  suite and the rule simulator.
- Calculation is unit-testable without a browser or a database.

**Costs**

- A round trip to recalculate. Mitigated by indicative client formulas for
  immediate feedback.
- Two representations of some arithmetic — the indicative client formula and the
  authoritative server pipeline — which can disagree. That is deliberate: the
  cross-check surfaces the disagreement rather than hiding it.
- More work than letting the form compute. This is the single most important
  place on the project not to take the cheap option.
