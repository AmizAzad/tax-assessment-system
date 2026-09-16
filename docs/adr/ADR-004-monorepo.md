# ADR-004: Monorepo with enforced module boundaries

**Status:** Accepted
**Date:** 2026-10-01
**Plan reference:** V2 sections 3.1, 14.1, 14.2

## Context

Four deployable units (api, worker, bpmn-engine, web) and several shared
packages. Team of roughly eight.

Cross-cutting changes are the normal case here, not the exception: adding a
status code touches a migration, a service, a shared enum and a screen. Adding
an API route touches the route, the permission seed, the OpenAPI contract and
the front-end client.

## Decision

**A single repository**, with npm workspaces and TypeScript project references.

**A modular monolith for the API**, not microservices. The module groupings are
boundaries first; they become service boundaries only if load or team structure
demands it, and the seams are drawn so that extraction is possible later.

### Enforced import direction

```
tax-assessment  ->  workflow, forms, platform, packages
workflow        ->  platform, packages
forms           ->  platform, packages
platform        ->  packages
```

**Nothing imports from `tax-assessment`.** This is what keeps the platform
reusable and the domain replaceable.

Enforced by `eslint-plugin-boundaries` in CI. Without enforcement this erodes
in weeks: the first time someone needs a case status inside a notification
template, the dependency goes in backwards and nobody notices.

## Consequences

**Good**

- One atomic commit per cross-cutting change; no version coordination between
  repositories.
- Shared contracts cannot drift.
- One CI pipeline, one lint configuration, one dependency graph to audit.

**Costs**

- CI runs more than strictly necessary on a small change. Acceptable at this
  size; add affected-project filtering if it becomes slow.
- The repository will grow large. Mitigated by keeping build artefacts and
  `node_modules` out of it.
- A monolith invites accidental coupling. The boundaries lint rule is the
  entire answer to that, which is why it is a CI gate and not a guideline.

## Why not microservices now

At this team size, service boundaries drawn before the domain is understood
become distributed coupling: the same change, spread across three repositories
and three deploys, with a network call where a function call would do. The
module boundaries above capture the same separation with none of the
operational cost, and they are where the seams will be when extraction is
actually justified.
