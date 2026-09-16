# ADR-008: Where JSONB is allowed, and where it is not

**Status:** Accepted
**Date:** 2026-10-02
**Plan reference:** V2 sections 2.7, 13.1, 13.4

## Context

PostgreSQL's `jsonb` is genuinely useful here. Form definitions are trees of
arbitrary shape. Rule sets differ between jurisdictions. Evidence payloads come
from systems we do not control. Modelling any of those as relational tables
means a migration every time a jurisdiction wants a field nobody anticipated,
which is the opposite of what this platform is for.

It is also the easiest way to lose a tax system. A `jsonb` column accepts
anything: a misspelled key, a number where a decimal string belongs, a nested
object where a scalar was expected. Nothing rejects it, nothing indexes it
usefully, and the error surfaces months later as a figure that cannot be
reconciled.

The question is not "JSONB or not". It is **which facts may live inside one**.

## Decision

**A `jsonb` column may hold configuration, captured payloads and audit
detail. It may never hold a fact the system computes with, enforces against,
or reports on.**

Concretely:

| Allowed in `jsonb`                                         | Why                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| `form_template.definition` — the element tree              | Arbitrary shape by design; validated by the form engine   |
| `form_submission.values` — what was submitted              | Mirrors the template, which is itself configuration       |
| `tax_rule_set_item.parameters` — band edges, rates, caps   | Shape differs per rule type and per jurisdiction          |
| `tax_assessment_evidence.request_json` / `response_json`   | A verbatim record of a third party's answer, hashed       |
| `tax_assessment_event.payload_json` — event detail         | Audit narrative; read by humans, never by the calculator  |
| `grid_definition.column_defs` — register columns           | Configuration, and resolved through a code-side allowlist |
| `export_job.filters_json` — what an export was filtered to | A record of a request, for explaining the file later      |

| Never in `jsonb`                                         | Where it lives instead             |
| -------------------------------------------------------- | ---------------------------------- |
| Any monetary amount that is computed with                | `NUMERIC(20,4)` column (ADR-007)   |
| Case status, liability status, any state                 | A column with a `CHECK` constraint |
| Statutory dates: due, anchor, limitation, deemed service | `date` / `timestamptz` columns     |
| Anything a report groups by or a register filters on     | A column, indexed                  |
| Anything a foreign key should point at                   | A `bigint` with a real reference   |
| Role codes that decide access                            | `role_permission` rows             |

### The rule restated as a test

Before putting a field in `jsonb`, ask: **would a wrong value here produce a
wrong tax figure, an unenforceable deadline, or a wrong access decision?** If
yes, it is a column with a constraint. If it would only produce a confusing
screen, `jsonb` is fine.

### Extraction where both are needed

Where a value inside a payload must also be queried — the taxpayer's declared
turnover, say — it is **extracted into a column on write**, not queried out of
the JSON at read time. The payload stays as the verbatim record; the column is
the queryable fact. Two representations, one of which is authoritative, and the
extraction happens once in a named place rather than in every query that needs
it.

## Consequences

**Good**

- A jurisdiction adds a rule parameter without a migration.
- Evidence is kept exactly as it arrived, which is what an appeal needs.
- Every figure the system computes with has a type, a constraint and an index.

**Costs**

- The boundary is a judgement call at the margin, and needs stating in review
  rather than being obvious from the schema.
- Extraction-on-write is duplication, and the two can drift if the extraction
  is not the only writer. It is.
- `jsonb` configuration is validated by code rather than by the database, so
  the validation has to be tested as carefully as a constraint would be.

## Related

- ADR-007 — money is a `NUMERIC` column, never a JSON number
- ADR-009 — the event ledger's `payload_json` is audit detail, not state
- ADR-016 — register columns are `jsonb` configuration resolved through a
  code-side allowlist, which is what makes them safe to edit
