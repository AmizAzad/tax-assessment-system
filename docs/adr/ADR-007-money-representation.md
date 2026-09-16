# ADR-007: Money as an exact decimal type

**Status:** Accepted
**Date:** 2026-10-01
**Plan reference:** V2 sections 2.2, 13.4

## Context

This system computes tax liabilities. A liability is a legal figure: it is served on a taxpayer, it can be objected to, appealed, and tested in court, and it must be reproducible years later from the data as it stood.

JavaScript's `number` is an IEEE 754 double. It cannot represent 0.1 exactly. `0.1 + 0.2` evaluates to `0.30000000000000004`. The error is tiny, but it is real, it accumulates across a nine-step calculation pipeline, and it is not defensible in an appeal — "the arithmetic was approximately right" is not a position anyone wants to argue.

This was the single strongest argument against choosing TypeScript over Java for the backend (ADR-001), where `BigDecimal` is idiomatic and the problem does not arise. Having chosen TypeScript for the reasons in ADR-001, we owe a concrete answer here rather than an assurance.

## Decision

Monetary values are represented by a `Money` class in `@tas/decimal`, backed by `decimal.js`, and **never** by a JavaScript `number`.

Five controls make this real rather than aspirational:

### 1. `NUMERIC(20,4)` in the database

Every monetary column. Never `float`, `double precision` or `real`. Twenty digits with four decimal places covers any realistic liability with room for intermediate precision.

### 2. The driver returns strings

Sequelize is configured with `decimalNumbers: false`. If the driver hands us a JS number, precision is already gone before any of our code runs — so it must not.

### 3. `Money` is a class, not a type alias

TypeScript rejects `money + money` on an object type with error 2365. The most common way to reintroduce floating point is therefore a compile error rather than a silent defect. The class defines no `valueOf`, so it cannot be coerced into arithmetic accidentally.

### 4. Lint rules close the remaining gap

The compiler cannot stop someone calling `.unsafeToNumber()` and doing arithmetic on the result. `no-restricted-syntax` in `.eslintrc.js` rejects arithmetic operators applied to identifiers named like amounts, `Math.round` on money, and `Number()` coercion. These are name-based heuristics: they are review prompts, not a type system, and they are deliberately noisy in the right direction.

### 5. Test bar

100% statement, branch, function and line coverage on `@tas/decimal`, enforced by the Jest threshold. Property-based tests assert commutativity, associativity, round-trip subtraction, allocation exactness and rounding idempotency — the properties that doubles break.

### Supporting design choices

**Rounding has no default.** `RoundingMode` must be stated at every call site, and comes from `tax_rule_set.rounding_rule`. Tax law does not agree on rounding: some jurisdictions round half away from zero, some round half to even to avoid systematic bias, some always round liabilities down and refunds up. A default would be a silent wrong answer in some jurisdiction.

**Intermediate results are not rounded.** Working precision is 34 significant digits (decimal128). Rounding happens only where a statutory rule says to, because rounding early and rounding often is itself a source of disputes.

**Rates are not Money.** Multiplying money by money is meaningless. Rates and percentages are `Decimal`, constructed through `Money.rate()` / `Money.percent()` so that they get the same precision guarantees.

**Construction from `number` is named `unsafeFromNumber`.** By the time a value arrives as a `number` it may already have lost precision at a JSON or form boundary. Those call sites need review, so they are made visible rather than convenient.

**`allocate()` exists.** Splitting 100.00 three ways by naive division loses a minor unit. The method distributes the remainder across leading shares so the parts sum exactly back to the whole.

## Consequences

**Good**

- Exact arithmetic end to end, with a test suite that proves it.
- Currency mismatches throw rather than silently producing a meaningless number.
- Serialisation is a string at every boundary, so precision survives JSON.
- The rounding rule applied is explicit at every call site and therefore reviewable against the statute.

**Costs**

- More verbose than operators: `a.add(b).multiply(rate)` rather than `a + b * rate`.
- `decimal.js` is slower than native arithmetic. Irrelevant at this scale — a calculation is dozens of operations, not millions — but worth knowing.
- The lint rules are name-based and will occasionally fire on a non-monetary identifier called `total`. Suppress with a comment explaining why it is not money.
- Anyone can still call `unsafeToNumber()` and do the wrong thing. The name and the review checklist are the mitigation; there is no way to make it impossible.

## Alternatives considered

**Integer minor units (store pennies as `bigint`).** Exact and fast. Rejected because tax computation involves rates and intermediate values with more than two decimal places — a 19% rate on an odd base produces sub-minor-unit precision that matters before the final rounding step. Working in minor units would force early rounding, which is the thing we are trying to avoid.

**A `number` with disciplined rounding.** Rejected. Discipline is not a control, and the failure mode is silent.

**Java for the calculation service only.** A defensible option: `BigDecimal` is idiomatic and the rest of the stack could stay TypeScript. Rejected because it introduces a second language, a second deployable and a serialisation boundary in the highest-risk part of the system, to solve a problem the five controls above already solve. Worth revisiting only if those controls prove insufficient in practice.

## Verification

```bash
cd packages/decimal && npx jest --coverage
```

74 tests, 100% coverage across all four metrics.
