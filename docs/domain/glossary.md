# Domain glossary

Tax assessment terms as this system uses them. Where a term has a narrower meaning here than in general tax practice, the narrowing is stated.

Deliberately jurisdiction-neutral: anything jurisdiction-specific is configuration, not vocabulary.

---

## Parties and scope

| Term                | Meaning here                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| **Taxpayer**        | Legal or natural person subject to tax. `platform.taxpayer`                                               |
| **TIN**             | Taxpayer identification number. Format is jurisdiction configuration, validated by a configurable pattern |
| **Tax type**        | CIT, PIT, VAT, WHT, excise. Drives which forms, items and credits apply                                   |
| **Tax period**      | The period assessed (`period_start`, `period_end`)                                                        |
| **Assessment year** | The label under which a period is assessed. Not always the calendar year                                  |
| **Jurisdiction**    | The tax authority whose rules apply. Present on rule sets, deadline configs, templates and cases          |

---

## The assessment

| Term                  | Meaning here                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Case**              | One assessment of one taxpayer for one tax type and period. The unit of work. `tax.tax_assessment_case`                                                                                     |
| **Case number**       | The externally quoted identifier. Also the BPMN **business key**, which is how objection and appeal processes correlate to their parent                                                     |
| **Declared figures**  | Amounts as the taxpayer filed them                                                                                                                                                          |
| **Assessed figures**  | Amounts as the authority determines them                                                                                                                                                    |
| **Assessment item**   | One line of the assessment — a concept such as "operating revenue" — carrying declared, assessed and difference                                                                             |
| **Adjustment**        | A change from declared to assessed, with type, reason code, amount, direction, narrative and evidence. Normalised into `tax_assessment_adjustment` as well as stored in the submission JSON |
| **Evidence snapshot** | The source data as it stood at retrieval, hashed and **append-only**. An assessment defended in court must be reproducible from it                                                          |

---

## Computation

| Term                         | Meaning here                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Taxable base**             | Assessed income, turnover or value after adjustments and loss set-off                                                                                                          |
| **Tax liability**            | Base multiplied through the rate structure                                                                                                                                     |
| **Credits**                  | Amounts reducing liability: withholding tax, advance tax, foreign tax credit. Ordered and capped by rule                                                                       |
| **Penalty**                  | A statutory addition. Often "the greater of a fixed amount and a percentage" — a shape the form formula engine cannot express, which is part of why computation is server-side |
| **Interest**                 | A statutory addition accruing over time, across a rate schedule with a day-count convention                                                                                    |
| **Net payable / refundable** | The final position after credits and payments                                                                                                                                  |
| **Rule set**                 | The versioned, effective-dated configuration that drives computation: rates, bands, thresholds, penalty and interest rules, rounding. `tax.tax_rule_set`                       |
| **Calculation trace**        | The stored, step-by-step explanation of how a figure was reached. Every result has one                                                                                         |
| **Inputs hash**              | A hash of everything fed to the pipeline. With the rule-set version, it makes a result reproducible                                                                            |

---

## Decision and instrument

| Term                    | Meaning here                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Assessment decision** | The determination: no change, additional tax, refund, or nil                                                                                                          |
| **Notice / order**      | The legal instrument served on the taxpayer. Rendered, signed, checksummed and verifiable                                                                             |
| **Service of notice**   | The act of delivery **and its proof**. Distinct from generation                                                                                                       |
| **Service date**        | The date from which statutory clocks run. Objection and appeal windows are computed from this, never from the finalisation date                                       |
| **Deemed service**      | Jurisdiction rules that treat a notice as served without proof of receipt — for example, portal publication is service, or post is service plus N days. Configuration |

---

## Dispute

| Term                   | Meaning here                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Objection**          | First-instance challenge to the authority itself                                                                                          |
| **Admissibility**      | Whether an objection is entertained: filed in time, grounds stated, deposit paid. Decided **server-side** against the stored service date |
| **Condonation**        | Acceptance of a late filing where the jurisdiction permits it                                                                             |
| **Appeal**             | Escalation to a tribunal, court or higher authority                                                                                       |
| **Forum**              | The body hearing an appeal. Configuration                                                                                                 |
| **Stay of collection** | Suspension of collection pending an outcome. Affects liability status, not case status                                                    |
| **Remand**             | An appellate decision sending the matter back for fresh determination                                                                     |

---

## Revision and closure

| Term                  | Meaning here                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reassessment**      | A new assessment superseding a previous one. Creates a **successor case** with `predecessor_case_id` and `version = n+1`. It never reopens the predecessor |
| **Limitation period** | The time limit on the authority's own power to assess or reassess. Expiry produces `TIME_BARRED`                                                           |
| **Settlement**        | Closure by payment or acceptance                                                                                                                           |
| **Write-off**         | Closure by abandoning an uncollectible liability, subject to authority thresholds                                                                          |
| **Closure**           | Terminal state. Sets retention                                                                                                                             |
| **Legal hold**        | A flag blocking retention-driven deletion regardless of retention class. Set on cases under appeal                                                         |

---

## Process and access

| Term                      | Meaning here                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step code**             | Identifies a workflow step. Present on the BPMN user task and on the transition table                                                                     |
| **Action code**           | What the actor did: `SUBMIT`, `RETURN`, `APPROVE`. Derived from the form's ButtonGroup; the BPMN layer never defines actions                              |
| **Role code**             | The unit of authorisation. Appears on BPMN tasks, permission mappings and scope predicates                                                                |
| **Delegation**            | Time-boxed authority for one user to act in another's role, with a reason and an audit trail                                                              |
| **Segregation of duties** | The rule that reviewer is not preparer and approver is not reviewer. Enforced at transition time                                                          |
| **SLA**                   | An internal service-level target. Distinct from a statutory deadline: missing an SLA is a management problem, missing a statutory deadline is a legal one |

---

## Registers, exports and screens

| Term                   | Meaning here                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Register**           | A configurable list of cases. Its columns are rows in `platform.grid_definition`, not markup                                                        |
| **Grid key**           | Names a published register, e.g. `ASSESSMENT_REGISTER`. Not a table name                                                                            |
| **Column key**         | What a grid definition names. The server maps it to SQL through a fixed allowlist; configuration never supplies SQL (ADR-016)                       |
| **Export-only column** | Present in the file and not on screen. Keeps a working queue readable without losing the detail an auditor reconciles against                       |
| **Export job**         | A recorded request for a copy of a register: who, when, filtered to what. Carries the requester's scope, and only they may collect it               |
| **Scope predicate**    | The SQL that decides which cases a caller may see. One function, shared by the register, the dashboard and the export, so the three cannot disagree |
| **Dashboard**          | The caller's own position — their cases, their deadlines. Scoped, unlike a report                                                                   |
| **Report**             | A question about the whole register. Deliberately unscoped; access controlled at the route instead                                                  |
| **Draft**              | Unsent work held in the officer's browser. Never posted, so a half-finished adjustment never reaches the case record                                |

---

## Process and diagrams

| Term                    | Meaning here                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Journey**             | Where a case has reached in its process: what has finished, what is waiting now. Derived from the engine's event stream, never stored separately          |
| **Coordinated**         | Whether a process instance is driving the case. `false` is normal — a case opened while the engine was unreachable is worked by hand                      |
| **Diagram interchange** | The coordinates a BPMN viewer needs. Our definitions are authored without them and laid out by the server, so the reviewed XML stays free of coordinates  |
| **`apiInvoker`**        | The single delegate every service task calls. Carries an idempotency key derived from the process instance and activity, which is what makes a retry safe |
| **Service account**     | The engine acting as itself: `tas-bpmn`, holding `SYSTEM`, granted exactly the routes a service task calls. Not a shared secret that skips authorisation  |

---

## Two distinctions worth keeping straight

**Case status vs liability status.** Separate columns, never conflated. A case can be `CLOSED` while its liability is `PARTLY_PAID`.

**Statutory deadline vs SLA.** Both are clocks, with very different consequences. A statutory deadline lives in `tax_assessment_deadline`; an internal service level lives in `tax_sla_tracker`, and the dashboard reports them in separate panels so they are never read as one number.

**Assessed vs collected.** Assessed is what was determined; collected is what arrived. They are separate figures on every screen and in every report, and are never added together.
