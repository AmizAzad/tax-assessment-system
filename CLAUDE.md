# CLAUDE.md

Configuration-driven tax assessment platform. npm-workspaces monorepo, NestJS + TypeScript API, Angular web, Flowable (Java) workflow engine, PostgreSQL.

This file is the contract for agents working here. The invariants below are architectural controls, not style preferences — several are enforced by lint and by database triggers, and breaking one produces a wrong tax liability served on a taxpayer.

## Commands

| Task | Command |
| --- | --- |
| Full gate (run before any commit) | `npm run verify` — format:check, lint, typecheck, test |
| Typecheck only | `npm run typecheck` (project references, `tsc --build`) |
| Lint / autofix | `npm run lint` / `npm run lint:fix` |
| Unit + integration tests | `npm test` (all workspaces) |
| Money coverage gate | `npm run test --workspace @tas/decimal -- --coverage` — 100% branch, CI-blocking |
| E2E | `npm run test:e2e` (Playwright) |
| Infra up / down / reset | `npm run dev:up` / `dev:down` / `dev:reset` |
| Migrate / seed | `npm run db:migrate` / `npm run db:seed` |
| Run API / web / worker | `npm run start:api` / `start:web` / `start:worker` |

Integration tests expect the Postgres from `npm run dev:up` with migrations applied. Unit tests (`@tas/decimal`, `@tas/contracts`, `@tas/dynaforms-core`, calculation) run without Docker.

Node 22 LTS, npm 10+. The BPMN engine needs Java 17 + Maven; everything else does not.

## Layout

```
apps/api              @tas/api — modular monolith (NestJS)
  src/platform        auth, authorization, audit, document, export, grid, i18n,
                      masters, notification, scheduling — jurisdiction-agnostic
  src/tax-assessment  case, evidence, calculation, deadline, approval, notice,
                      dispute, lifecycle, portal, selection, reporting, dashboard
  src/workflow        Flowable client, BPMN validator, task inbox, reconciliation
  src/forms           form template resolution and submission
apps/web              @tas/web — Angular
apps/worker           @tas/worker — scheduled work
apps/bpmn-engine      Flowable (Java/Maven, pom.xml)
packages/decimal      @tas/decimal — exact Money type (ADR-007)
packages/contracts    @tas/contracts — DTOs, enums, case state machine
packages/dynaforms-*  forked form engine, core runs in browser and server (ADR-005)
db/migrations         29 sequelize migrations, timestamp-ordered
config/               rule-sets, form-templates, notice-templates, bpmn
docs/adr              the decisions that constrain changes here
```

## Invariants

**Money is never a number.** Use `Money` from `@tas/decimal`. No `+ - * / %` on monetary identifiers, no `Math.round`, no `new Number` on a monetary string — all three are `no-restricted-syntax` lint errors. Rounding goes through `Money.round()` with an explicit statutory `RoundingRule`. (ADR-007)

**Module boundaries are enforced by `import/no-restricted-paths`.** `tax-assessment` may import from `workflow`, `forms` and `platform`. Nothing may import from `tax-assessment`. `packages/*` may not import from `apps/*`. Adding an import that crosses a zone fails lint — restructure, do not disable the rule.

**Calculation is server-side and pure.** The client never computes a liability. The pipeline takes explicit inputs and a rule set, touches no database, clock or browser, and emits a trace alongside the figures. A right answer reached by the wrong route is a defect. (ADR-006)

**The domain event ledger is the audit system of record**, and audit tables are append-only, enforced by database trigger rather than by grant. Never write an UPDATE or DELETE against them, in code or in a migration. (ADR-009, ADR-013)

**Configuration chooses from an allowlist; it never supplies SQL or expressions.** A new configurable behaviour means a new allowlist entry plus the code path behind it. (ADR-016)

**JSONB has defined boundaries.** Read ADR-008 before putting anything new in a JSONB column; identity, money and anything queried or joined stays relational.

**External dependencies sit behind provider interfaces** (ADR-010). Integrate through the port, not against the vendor.

**Flowable is the only workflow engine** (ADR-002). Authentication is Keycloak; authorisation logic stays in our code (ADR-003).

## Changing calculation or rule sets

The golden-case corpus (`apps/api/test/golden-cases.spec.ts`, 42 cases over `apps/api/test/fixtures/uk-cit-rule-set.ts`) pins inputs, expected outputs **and expected traces**, and is a blocking CI gate. A rule-set change must produce an intentional, reviewed diff to those fixtures. A silent change to an expected liability is the exact failure mode the corpus exists to catch — never regenerate fixtures to make a test pass.

GB CIT is v1; the second jurisdiction is proved by configuration alone, with no code change. A change that requires code to add a jurisdiction is a design defect, not a feature.

## Committing

Commit your own work — do not leave changes uncommitted for the user to stage.

- Run `npm run verify` before committing. A failing gate means fix it or report it, never commit through it.
- One commit per logical unit of work, not one commit per session. Stage the files you actually changed by path; never `git add -A` or `git add .`.
- Conventional Commits: `feat|fix|refactor|docs|test|chore(scope): subject`, subject in the imperative and under 72 characters. Body only when the "why" is not obvious from the diff. Scope is the workspace or domain (`api`, `web`, `decimal`, `calculation`, `db`).
- Never commit `.env`, `.dr-backups/`, `playwright-report/`, `test-results/`, or anything else gitignored.
- Never commit directly to `main` when the change is non-trivial — branch first (`git switch -c <type>/<short-name>`).
- Push the branch to `origin` once its commits are made — `git push -u origin <branch>`. Standing authorisation; do not ask each time. Report the branch and the remote you pushed to.
- Never push to `main`, and never force-push. Both stay denied in `.claude/settings.json`; a rejected non-fast-forward means rebase on the fresh `origin/main` and push again, never `--force`.
- Opening a PR is still a separate, explicit ask.
- Rule-set and golden-fixture changes get their own commit, with the intended liability diff stated in the body.

## Conventions

- Migrations are append-only and timestamp-named (`YYYYMMDDHHMMSS-description.js`). Never edit a migration that has run; add a new one.
- `docs/adr/` is where decisions live. Contradicting an ADR means writing a new ADR, not a code comment.
- Reference docs before re-deriving: `docs/architecture.md`, `docs/running-locally.md`, `docs/testing.md`, `docs/development.md`, `plans/V2_tax_assessment_greenfield_plan_11092026.md`.
- `.env` is local-only and gitignored; `.env.example` is the tracked shape.
