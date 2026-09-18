# Forms and the process modeller

The two administrator surfaces where a deployment changes behaviour without a
release: the form builder that publishes templates the officer workbench then
renders, and the BPMN modeller that shows the server's verdict on a deployed
definition.

## Sub-features

- The process journey screen, including saying plainly when nothing is
  coordinating the case (the engine is optional).
- The modeller is an administrator's screen, and refuses everyone else.
- The server's validation verdict on the deployed definition is shown, not guessed.
- The modeller offers only the properties a definition here may carry.
- The form builder: drop a Section, add a Dropdown and a Text field, give the
  text field a show-when rule, Preview it in the real renderer, Publish as
  `admin-tax`.

## How to get to it (user POV)

**Forms → "Open the builder"** and **the process journey / modeller** from the
case workbench, signed in as `admin-tax`. A published template is live
immediately: a reason code added in the builder appears in the officer's
adjustment dropdown with no release (`docs/running-locally.md` §25).

## Driving it with Playwright

`apps/web/e2e/06-journey-and-modeller.spec.ts`.

```bash
npx playwright test apps/web/e2e/06-journey-and-modeller.spec.ts
```

The renderer is `@tas/dynaforms-core`, which runs identically in the browser
and on the server (ADR-005) — so a rule that behaves differently in Preview and
in the workbench is a real defect, not a test artefact.

## Gotchas

- Publishing writes a real template. A run that publishes leaves state behind
  for the next run; give templates distinguishable names and clean up.
- BPMN definitions are validated by `apps/api/src/workflow/bpmn-validator.ts`
  at publish time. Show the server's verdict; never re-implement the check in
  the front end to make the screen agree with itself.
- The property palette is an allowlist. "The modeller won't let me set X" is
  usually ADR-016 working, not a bug.
- Flowable needs Java 17 and Maven. Without them the journey screen must still
  say plainly that nothing is coordinating the case — that message is asserted,
  so do not treat it as a placeholder to delete.
