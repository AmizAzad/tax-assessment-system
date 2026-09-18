# Working with agents on this codebase

This repository is set up for [pstack](https://github.com/backnotprop/pstack) —
a set of engineering playbooks an agent follows so that work here is designed,
verified and landed the way a careful engineer would do it, rather than
generated and hoped over.

Three things make that work, and all three are already in place:

| Piece | Where | What it does |
| --- | --- | --- |
| Repository contract | [`CLAUDE.md`](../CLAUDE.md) | The invariants, commands and conventions an agent is expected to know before it writes a line |
| Runtime proof | `.claude/skills/verify-tas/` | How to launch the real stack and drive it as an officer, with a feature map |
| Executable controls | `npm run guards` | Money boundaries, the append-only ledger and SQL interpolation, enforced rather than reviewed |

## Start a task with the playbook, not with the code

`/poteto-mode <what you want>` picks a playbook and works through its steps.
The mapping that matters here:

| What you are doing | Playbook | Why this one |
| --- | --- | --- |
| "How does evidence retrieval decide what is current?" | **investigation** | Read-only, answered with citations. No code changes. |
| A wrong figure, a wrong date, a wrong status | **bug fix** | Reproduce with runtime evidence first. In this domain the reproduction *is* the specification of the defect. |
| New or changed assessment behaviour | **feature** | Names the data shape before the code. Most defects here are shape defects wearing a logic costume. |
| A rule-set or calculation change | **feature**, then **interrogate** | The golden corpus pins traces as well as figures; a contested calculation deserves adversarial review before it lands. |
| Restructuring without behaviour change | **refactoring** | The module boundary zones are the thing most easily eroded. |
| "The register is slow at 900k cases" | **perf** | Against a measured baseline, not an impression. `npm run load:seed` exists for this. |
| Adding the next jurisdiction | **multi-phase plan** | Stacked PRs; the whole point is that it is configuration, so the diff should be seeds and rule sets. |
| A design fork with no obvious answer | **prototype** or **arena** | Settle it by observation or bakeoff instead of asking for a preference nobody holds. |
| Driving a PR to green | **babysit** | Conflicts, review threads, CI. |
| Long unattended work | **autonomous run** | Leaves a decision trail you can audit in the morning. |

## The rule that matters most here

**Never make a golden-case fixture agree with new output.** The corpus in
`apps/api/test/golden-cases.spec.ts` exists precisely to make a changed
liability visible. A rule-set change should produce a reviewed, intentional
fixture diff, described in the commit body. Regenerating fixtures to get a
green run destroys the only control that catches a silently wrong tax figure.

Everything else follows from `CLAUDE.md`: money is never a number, nothing
imports from `tax-assessment`, the event ledger is append-only, and
configuration chooses from an allowlist it can never add to.

## Before review, before commit

```bash
npm run verify          # format, lint, guards, guard self-test, typecheck, tests
```

`/no-comments` before review and `/unslop` on any prose surface — a PR
description, an ADR, a README — keep the written output at the same standard as
the code. `/technical-writing` is the one to reach for when writing an ADR,
because an ADR that does not state what it rejected is not a decision record.

For a change whose claim is about behaviour rather than types, run the
`verify-tas` skill and put the evidence in the PR. A green unit suite is not a
demonstration that an officer can do their job.
