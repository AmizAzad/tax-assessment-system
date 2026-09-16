# ADR-016: Configuration chooses from an allowlist; it never supplies SQL

**Status:** Accepted
**Date:** 2026-10-10
**Plan reference:** V2 sections 6.8, 18.1 screen 3, 21.1

## Context

This platform's value proposition is that a deployment configures rather than
releases. Register columns are the clearest case: one authority wants the
assigned officer on the register, another cannot show it for privacy reasons, a
third wants the limitation date in front of every caseworker. None of that is a
code question, and `grid_definition` exists to hold the answer.

The obvious implementation is to let a column definition carry the expression
that produces it — `c.taxpayer_name`, or a `CASE` expression for something
computed. It is flexible, it needs no code change ever, and it is how a great
many admin-configurable grids are built.

It is also an injection route with an administration screen in front of it.
"Only administrators can edit it" is not a defence: an administrator account is
precisely what an attacker works towards, and the whole point of the permission
model is that we assume accounts are reachable.

The same argument applies to anything else a caller or a configuration row
might contribute to a query — a sort column, a filter key, an export's column
set.

## Decision

**Configuration names a key. The server maps the key to SQL through a fixed
allowlist held in code. A key absent from the allowlist is refused.**

```ts
const SORTABLE: Readonly<Record<string, string>> = {
  caseNumber: 'c.case_number',
  netPayable: 'c.net_payable',
  openedAt: 'c.opened_at',
  // ...
};
```

Configuration chooses **from** what the code offers, and can never add to it.
The inversion is the whole design:

| Configuration may decide                        | Only code may decide                    |
| ----------------------------------------------- | --------------------------------------- |
| Which columns appear, in what order             | What a column key resolves to           |
| Which are on screen and which only in exports   | Which keys exist at all                 |
| How a column is rendered — amount, status, date | How a value is produced from the schema |
| The default sort                                | Whether a column may be sorted on       |

### Consequences for the caller-supplied `sort`

`sort=netPayable:desc` is the closest a caller gets to writing an `ORDER BY`.
The key is checked against the same allowlist and the direction is one of two
literals, so neither reaches SQL as caller text:

```ts
const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
return `${SORTABLE[sort.key]} ${direction}, c.id DESC`;
```

A refused sort names what _is_ sortable, so the API is discoverable without
being permissive.

### A definition that names an unknown column is an error, loudly

Reading a grid whose configuration names a key the register cannot supply
fails with 400 rather than rendering a blank column. A silently empty column is
a configuration defect that nobody notices until somebody makes a decision from
the screen.

## Consequences

**Good**

- Register configuration is safe to expose to administrators, because the worst
  a bad definition achieves is an error.
- The injection surface of the whole feature is one map per register, which is
  reviewable in one screen.
- The same allowlist serves the register, the sort, and the export, so a column
  cannot be exportable but not renderable, or vice versa.

**Costs**

- A genuinely new column needs a code change — one line in the map, plus a
  configuration row. That is the cost of the guarantee, and it is paid once per
  column rather than once per deployment.
- Two places to look when a column is missing: the allowlist and the
  configuration row. The 400 names which one is at fault.
- A computed column (a derived ageing band, say) has to be written into the map
  as an expression by a developer, not composed by an administrator.

## Related

- ADR-008 — the definition itself is `jsonb` configuration, which is only
  acceptable because of this ADR
- ADR-003 — authorisation decides _who_ may read a register; this decides what
  a register can be made to say
