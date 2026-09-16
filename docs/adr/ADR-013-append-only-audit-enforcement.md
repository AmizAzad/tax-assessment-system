# ADR-013: Append-only audit enforced by trigger, not by grant

**Status:** Accepted
**Date:** 2026-10-10
**Plan reference:** V2 section 19.3
**Supersedes:** the mechanism named in plan 19.3, not the requirement

## Context

Plan section 19.3 specifies the control:

> **Append-only** — database-level revoke of UPDATE and DELETE on
> `tax_assessment_event` and `tax_assessment_evidence` for the application
> role.

The requirement is right and is not in question. The mechanism does not work in
this deployment, and would not work in most.

`REVOKE UPDATE, DELETE ... FROM <role>` protects against a role that does not
own the table. In this system — and in every deployment that has not yet
separated the migration role from the runtime role — the application connects
as the owner of the schema. **An owner can grant itself back anything it has
revoked**, in one statement, from the same connection the application already
holds.

So a migration containing that REVOKE would look like a control in the diff,
pass review, and be no control at all in production. That is worse than having
none, because it would be cited as evidence that the ledger cannot be edited.

## Decision

**Append-only is enforced by a `BEFORE UPDATE OR DELETE` trigger that raises.
The grants are revoked as well, for deployments that do separate the roles —
both, not either.**

```sql
CREATE TRIGGER trg_event_append_only
  BEFORE UPDATE OR DELETE ON tax.tax_assessment_event
  FOR EACH ROW EXECUTE FUNCTION tax.refuse_mutation();
```

A trigger applies to the owner, to a superuser session, and to anybody who
reaches the database with `psql`. That is the property an audit control needs:
**the person you are guarding against is the one holding the credentials.**

### The one permitted mutation, and why it is not a loophole

`tax_assessment_event` is absolutely immutable — no UPDATE, no DELETE.

`tax_assessment_evidence` needs one exception. When evidence is retrieved
again, the previous snapshot is superseded: the row stays and `is_current`
moves to `false`. So its trigger permits an UPDATE that changes nothing but
that flag, and refuses one that touches the request, the response, the payload
hash or who retrieved it.

The comparison is done by nulling the flag on both `OLD` and `NEW` and
comparing the whole row:

```sql
before_row.is_current := NULL;
after_row.is_current  := NULL;
IF before_row IS DISTINCT FROM after_row THEN RAISE EXCEPTION ...
```

Written that way, **a column added by a later migration is protected
automatically** rather than being protected only if somebody remembers to add
it to a list. A control that depends on future diligence is a control with an
expiry date.

### Correcting a mistake

By appending a correcting entry, which is what the error message says:

```
ERROR:  Table tax.tax_assessment_event is append-only: UPDATE is refused
HINT:   Correct a mistaken entry by appending a correcting one.
```

An audit trail that can be tidied is not evidence of anything.

## Alternatives rejected

**Application-level guard.** Trivially bypassed by any other client, and by a
future service that forgets. The database is the only place every writer passes
through.

**A separate least-privileged runtime role.** Correct, and still worth doing —
it is orthogonal, not an alternative. Until the deployment topology separates
those roles, it protects nothing, and the trigger protects regardless.

**Postgres row-level security.** Governs which rows are visible, not whether
they may be rewritten. Wrong tool.

## Consequences

**Good**

- The ledger cannot be edited by anyone reaching the database, however
  privileged. Verified by attempting it as the owner.
- Evidence cannot be rewritten after the assessment was defended on it.
- The control is visible in the schema: the tables carry a `COMMENT` saying so.

**Costs**

- A legitimate bulk correction — a data migration fixing a genuine defect in
  historical events — must drop the trigger, act, and restore it, as a
  deliberate, reviewable, logged act. That friction is the point.
- A trigger runs per row, so a large batch insert into these tables pays for
  it. Inserts are unaffected; only UPDATE and DELETE fire.
- The evidence trigger compares whole rows, which is slightly more work than
  naming columns. Correctness over speed on a table written twice per case.

## Related

- ADR-009 — why this table is the system of record in the first place
- ADR-008 — `payload_json` holds audit detail, never state
