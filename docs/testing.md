# Testing strategy

Plan reference: [V2 section 26](../plans/V2_tax_assessment_greenfield_plan_11092026.md#26-testing-strategy).

---

## Why the bar is where it is

This system produces legal figures and statutory dates. A rounding defect is not a cosmetic bug — it is a wrong tax liability served on a taxpayer, potentially across every case computed after the defect shipped. The test strategy is shaped around that single fact.

Three things follow:

1. **The money package carries 100% coverage.** Not as a vanity metric — it is small, total, and every branch is a place where a currency could be wrong.
2. **Golden-case tests are a CI gate.** A rule-set change must show an _intentional, reviewed_ diff. A silent change to an expected liability is the failure mode we are guarding against.
3. **The calculation pipeline is pure**, so it can be tested exhaustively without a database, a clock or a browser.

---

## Levels

| Level              | Scope                                                                                                                                                         | Tooling                           | Gate                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------- |
| **Unit**           | Calculation steps, rule resolution, deadline computation, admissibility, numbering, hashing, scope predicates                                                 | Jest                              | 90%+ on calculation and deadline; **100% branch on rounding** |
| **Golden-file**    | Whole-case fixtures with expected outputs **and expected traces**. UK CIT today; not SME-signed                                                               | Jest + committed fixtures         | **Blocking**                                                  |
| **Property-based** | Rounding direction, non-negativity, monotonicity, idempotency of recalculation                                                                                | `fast-check`                      | Advisory in Phase 3, blocking from Phase 4                    |
| **Integration**    | Evidence retrieval, submission persistence, workflow transitions, notice render and sign, notification dispatch                                               | Jest + real Postgres in Docker    | Blocking                                                      |
| **Workflow**       | Every BPMN path including timers, escalation, boundary events; message correlation across main, objection and appeal                                          | JUnit with a test clock           | Blocking                                                      |
| **Contract**       | API to Flowable, API to providers. The BPMN side is covered by the publish-time validator and the engine integration tests                                    | Generated from OpenAPI            | Partial                                                       |
| **Security**       | RBAC matrix per role x route; record-level scoping; field-level enforcement on submit; public endpoint exposure                                               | Jest + manual review              | Blocking                                                      |
| **E2E**            | Multi-role journeys: initiate to close, including dispute. **Not built** — covered today by integration tests and the live probe, which is not the same thing | Playwright (intended)             | Not enforced                                                  |
| **Performance**    | Register at 920k cases, measured by hand (`npm run load:seed`). Calculation throughput and notice concurrency **not** measured                                | k6 (intended)                     | Not enforced                                                  |
| **Accessibility**  | WCAG 2.1 AA on the main journey. Focus visibility, skip link and the tab-list keyboard pattern are implemented; **no axe run and no manual audit yet**        | axe + manual (intended)           | Not enforced                                                  |
| **UAT**            | Tax officers on anonymised cases, per jurisdiction                                                                                                            | Manual, from the canonical corpus | Sign-off                                                      |

---

## The golden-case corpus

The most important test asset on the project.

### What exists today

- **42 cases** in `apps/api/test/golden-cases.spec.ts`, over the rule set in
  `apps/api/test/fixtures/uk-cit-rule-set.ts`.
- Grouped by the branch each one pins: the three rate regions and the
  boundaries between them, adjustments and losses, credits, penalties,
  interest, the net position, a progressive slab regime, and the trace itself.
- Each carries inputs, expected outputs **and the expected trace**, because a
  right answer reached by the wrong route is a defect that surfaces on the next
  rate change.
- They double as the rule simulator's regression baseline.

### What does not exist, stated plainly

- **They are not SME-signed.** The intended control is that any change to an
  expected value needs a tax-SME approver on the pull request. There is no such
  approver on this project, so the figures are illustrative and carry the same
  caveat as the seeded rule sets. Until somebody qualified signs them, a green
  suite proves the engine is _consistent_, not that it is _right_.
- **One jurisdiction.** The corpus is UK CIT. Saudi Arabia is configured and
  exercised end to end, but has no golden-case corpus of its own.
- The lifecycle branches — non-filer, amended, multi-year — are covered by the
  integration tests rather than by golden cases.

Both gaps are the kind that get quietly forgotten, which is why they are here
rather than in a backlog.

---

## Enforced coverage bars

| Package              | Statements             | Branches             | Functions | Lines |
| -------------------- | ---------------------- | -------------------- | --------- | ----- |
| `@tas/decimal`       | 100%                   | 100%                 | 100%      | 100%  |
| Calculation pipeline | 90%                    | **100% on rounding** | 90%       | 90%   |
| Deadline engine      | 90%                    | 90%                  | 90%       | 90%   |
| Everything else      | Sensible, not mandated |                      |           |       |

Blanket high coverage elsewhere is not a goal — it produces tests written to satisfy a number rather than to catch a defect.

---

## Structural tests

Some invariants are better asserted about the _shape_ of the system than about a behaviour. `packages/contracts/test/transitions.spec.ts` demonstrates the pattern by asserting that the case state machine:

- has exactly one entry point
- defines no transition out of a terminal status
- has no duplicate `(from, action)` pairs, which would make transitions non-deterministic
- gives every transition at least one permitted actor
- reaches every non-exception status from the entry point
- lets every non-terminal status reach a terminal status

That last pair already earned their place: the reachability test caught that `TIME_BARRED` and `WRITTEN_OFF` were listed as terminal statuses in the plan but had no transition producing them. Write structural tests wherever a configuration artefact could be internally inconsistent — rule sets, deadline configs and BPMN definitions all qualify.

---

## Test data

- Synthetic taxpayer, filing and payment data from a **seeded** factory, so volumes are reproducible.
- **No real taxpayer data in any non-production environment.** Where production-shaped data is needed for UAT it is anonymised, and the anonymisation is itself tested.

---

## Running

```bash
npm test                                   # everything
npm run verify                             # format + lint + typecheck + test

cd packages/decimal   && npx jest --coverage
cd packages/contracts && npx jest
cd apps/api           && npx jest          # integration needs npm run dev:up
```

---

## Current state

| Suite                 | Tests   | Status                                                       |
| --------------------- | ------- | ------------------------------------------------------------ |
| `@tas/decimal`        | 74      | Passing, 100% coverage on all four metrics                   |
| `@tas/contracts`      | 22      | Passing, including the structural invariants above           |
| `@tas/dynaforms-core` | 108     | Passing; the same engines the browser runs                   |
| `apps/api`            | 282     | Passing across 16 suites; integration needs `npm run dev:up` |
| `apps/web`            | 30      | Passing in headless Chrome                                   |
| **Total**             | **516** |                                                              |

### What the newest suites hold still

| Suite                   | What it is evidence of                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `grid.spec.ts`          | A register column key is resolved against an allowlist, so `sort` can never reach SQL as caller text                  |
| `export-writer.spec.ts` | A taxpayer name beginning `=` is not a formula in the officer's spreadsheet; money survives as exact text             |
| `bpmn-layout.spec.ts`   | A hand-authored definition can be drawn: a shape per element, an edge per flow, and it terminates on a cyclic process |
| `bpmn-diagram.spec.ts`  | In a real browser: the diagram renders, and the step being worked is marked differently from finished ones            |
| `security.spec.ts`      | The attacks a penetration test looks for, asserted as properties of the transition table and permission model         |

### Live checks against a running stack

These are not unit tests and are not run by `npm test`. They need the stack up.

```bash
npm run security:probe     # 44 authorisation and input checks
npm run dr:rehearse        # backup, restore, fingerprint compare
```

The probe covers anonymous access, forged tokens, cross-taxpayer access by
identifier, role separation, SQL metacharacters, mass assignment, export
scope, security headers and the rate limits. It is not a penetration test —
it automates the checks a tester runs first, so a change that quietly opens
one fails the build rather than surviving to the engagement.
