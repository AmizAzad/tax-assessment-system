# ADR-005: DynaForms forked into this repository

**Status:** Accepted, with an amendment (see _Amendment: no upstream source_)
**Date:** 2026-10-01
**Amended:** 2026-10-02 after the extraction spike
**Plan reference:** V2 sections 3.2, 3.3, 4.5

## Context

DynaForms is an existing JSON-defined form engine: builder, renderer,
dependency engine, validation engine, formula engine, around 29 widget types.
It is the reason this project can treat 18 assessment forms as configuration
rather than as 18 Angular components.

It could be consumed as a versioned package, run as a separate service, or
forked into this repository.

## Decision

**Fork it**, as two packages:

| Package                      | Contents                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/dynaforms-core`    | Form definition model, dependency engine, validation engine, formula evaluation. Framework-agnostic TypeScript |
| `packages/dynaforms-angular` | Builder and renderer components                                                                                |

### Why fork rather than consume

1. **This is a standalone project.** There is no shared platform release train
   to track. A package dependency implies an upstream that maintains it for us;
   that upstream does not exist here.

2. **Validation must run server-side.** Client-side validation is a UX
   affordance and never a control. The API has to execute the same validation
   and dependency logic the browser ran — not a re-implementation, which will
   drift. That requires the core to be extractable from the Angular components,
   which requires owning the code.

3. **We need schema extensions** that a consumer cannot make: `readOnlyForRoles`
   for field-level access, `source: 'server'` for server-fed read-only fields,
   and a structured audit hook on submission write.

### Why split core from Angular

So the same validation and dependency code runs in the browser and on the
server. This is the main technical reason the fork is two packages rather than
one.

## Fork discipline

Owning the code is a licence to make it worse. Three rules, enforced:

1. **No tax domain code in `dynaforms-*`.** The packages know about fields,
   validation and layout. They must never know what a tax adjustment is.
   Enforced by the import-boundary lint rule.
2. **Every divergence from upstream behaviour gets an ADR**, so that a future
   decision to re-converge is possible.
3. **Extensions go through the element schema**, never through special cases in
   the renderer. `readOnlyForRoles` is a schema property, not
   `if (isTaxForm) { ... }`.

## Planned extensions

| Extension                                                  | Why                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| `readOnlyForRoles` element property                        | Field-level access without a bespoke role-locking component                |
| Server-side execution of validation and dependency engines | Validation must be a control, not an affordance                            |
| `ROUND` / `MIN` / `MAX` / `IF` in the formula language     | Richer on-screen cross-checks only — **never authoritative** (ADR-006)     |
| `derived_from_template_id`                                 | Year-on-year template lineage                                              |
| `source: 'server'` fields                                  | Calculation results render but are never editable or client-computed       |
| Structured audit hook on submission write                  | Feeds the domain event ledger without the domain reaching into the package |

## Consequences

**Good**

- Full freedom to extend, and no upstream release to wait for.
- The same validation code on both sides of the trust boundary.

**Costs**

- We own all maintenance and all security fixes for this code.
- Divergence from upstream is permanent unless deliberately managed, which is
  what rule 2 is for.
- The fork is a large amount of code to take responsibility for in Phase 1.

---

## Amendment: no upstream source, and what we did instead

**The upstream DynaForms source is not available to this project.** There is
no repository, package or archive of it on the development machine, and this
is a standalone build with no access to the iFile-Teapot codebase. A literal
"fork" was therefore not possible.

What we did: implemented `dynaforms-core` **clean-room against the documented
contract** in V1 plan section 4 — the field-type enum, the element node keys,
the dependency operators and effects, the validation mechanisms, and the
formula engine's capabilities _and_ its documented limits.

### Why this is not a workaround

The decision this ADR exists to make was never "which files do we copy". It
was **"can the form core run framework-agnostically on the server, so that
validation is one implementation rather than two?"** That question is now
answered, with tests:

| Claim                                                   | Evidence                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| The core imports no framework or DOM package            | `portability.spec.ts` scans every source file                                   |
| It touches no browser global                            | Same                                                                            |
| It carries no domain knowledge (fork discipline rule 1) | Same — scans for domain terms                                                   |
| It runs in Node                                         | The whole suite runs under `testEnvironment: node`                              |
| Server and client reach identical results               | 6 value sets × state + validation, each parsed independently from the same JSON |
| Results survive the wire                                | JSON round-trip equality                                                        |
| Evaluation is deterministic                             | 20 runs, one distinct result                                                    |
| Evaluation mutates nothing                              | Definition and values byte-identical afterwards                                 |

### What this buys when upstream source does arrive

Reconciliation becomes a **merge against a known-good interface and a test
suite that already asserts the documented behaviour**, rather than a rewrite.
Specifically, the suite pins:

- the exact set of unsupported formula constructs (`SUM`, `ROUND`, `MIN`,
  `MAX`, `IF`, `VLOOKUP`, `&&`, `||`, `**`, `%`, ternaries, arrays, property
  access), each with the error the author should see
- that the engine is floating point, which is _why_ ADR-006 holds
- dependency effect semantics including baseline restoration and the rule that
  a hidden field is never required
- `clearOnHide` stripping values from what gets stored

If upstream behaviour differs from any of these, the difference is visible as a
failing test rather than a silent divergence.

### Risk this introduces

**The clean-room implementation may differ from upstream in ways the
documentation did not capture.** The V1 plan documented the model well, but
documentation is not source. Two consequences:

1. A form authored in the upstream builder may not render identically here.
   Mitigated by treating the element schema as the contract and versioning it.
2. If the intent was ever to share templates with an existing Teapot
   deployment, that needs validating against real definitions before anyone
   relies on it. **This is an open question for the platform team.**

The `dynaforms-angular` package — builder and renderer — remains unbuilt. It
is a much larger surface than the core and has no equivalent shortcut: a
renderer cannot be inferred from a documented contract. That is the real
remaining cost of the missing source, and it is Phase 1 work still to be
scoped.
