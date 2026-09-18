# Case lifecycle

One assessment moving from opened to approved and out as a served notice,
handled by six different officers in turn. This is the feature the product
exists to deliver; everything else supports it.

## Sub-features

- Opening a case against a taxpayer and a period (supervisor).
- Evidence retrieval — by the workflow engine, or by hand when it is not running.
- Assignment to a named assessor, and that assessor finding it in their own register.
- Preparation: adjustments on the published `TA-06-ADJUSTMENT` form, then calculation.
- Submission for review, and the refusal of self-review.
- Review acceptance, then approval **routed by amount**, not by who asks.
- Notice generation, signing and service.
- Objection, appeal, reassessment, settlement, closure (later stages of the same case).

## How to get to it (user POV)

Sign in at `http://localhost:4200` as `supervisor` / `password`. **Cases** in
the main navigation is the register; a case opens into the workbench, which is
where every stage above happens. The dashboard is the landing screen, and
`My Queues` is the same work filtered to the signed-in officer.

## Driving it with Playwright

`apps/web/e2e/01-lifecycle.spec.ts` is one test with a `test.step` per stage,
deliberately: the case is a single stateful thing and a mid-journey failure
should report once, naming the stage.

```bash
npx playwright test apps/web/e2e/01-lifecycle.spec.ts
npx playwright test apps/web/e2e/01-lifecycle.spec.ts --headed
```

Use the `as` fixture to act as a role, and the `Workbench` page object in
`apps/web/e2e/support/workbench.ts` rather than raw selectors. Extending the
journey means adding a step to the existing test, not a second test that has to
rebuild the state the first one left.

## Gotchas

- The engine may not be running (Java/Maven are optional). The spec covers both
  paths — engine-retrieved evidence and retrieved-by-hand — so a change that
  only works with Flowable up will pass locally and fail for the next person.
- Approval routing is by **amount**. A test case whose figures fall in a
  different band silently exercises a different route.
- Self-review and self-approval are refusals the spec asserts; if your change
  makes them succeed, that is the defect, not the assertion.
- The figures are `Money`. A step that compares a rendered amount to a
  JavaScript number is testing the wrong thing (ADR-007).
