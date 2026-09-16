# ADR-001: NestJS and TypeScript as the primary backend

**Status:** Accepted
**Date:** 2026-10-01
**Plan reference:** V2 section 2.2

## Context

A greenfield tax assessment platform. Two components are given: DynaForms (a TypeScript form engine) and BPMN execution. Everything else is ours to choose.

The backend has to host domain services, a calculation pipeline, a workflow wrapper and a form host, and it has to be maintainable by a team of roughly eight for a build measured in years.

## Decision

**NestJS on Node 22 with TypeScript** is the primary backend runtime. **Flowable on the JVM** is the single exception and is kept deliberately thin (ADR-002). The plan named Java 21; it is built and tested on Java 17, for the reason recorded in the ADR-002 amendment.

Reasons, in order of weight:

1. **One language across the form engine, the API and the SPA.** DynaForms is TypeScript and the front end is Angular. A TypeScript backend means form-definition types, status codes and DTOs are shared from `packages/contracts` rather than duplicated in two languages and drifting. For a system with roughly 60 status codes, 18 form templates and a large enum surface, this is a correctness argument, not a convenience one.

2. **The same validation code runs on both sides.** Client-side validation is a UX affordance and never a control. Splitting DynaForms into a framework-agnostic core (ADR-005) lets the API execute exactly the validation and dependency logic the browser ran. In a two-language stack that becomes a re-implementation, and re-implementations drift.

3. **NestJS supplies the structure this system needs** — module boundaries, DI, guards, interceptors, OpenAPI generation — without inventing it.

## The objection, and the answer

JavaScript's `number` is an IEEE 754 double and is unsafe for currency. This is the one serious argument for Java, where `BigDecimal` is idiomatic.

It is answered concretely in **ADR-007**: `NUMERIC(20,4)` columns, a driver configured to return strings, a `Money` class that makes `a + b` a compile error, name-based lint rules against monetary arithmetic, and a 100%-coverage bar on the money package with property tests for the properties doubles break.

**Those controls are load-bearing, not aspirational.** With them, TypeScript is as safe here as Java. Without them it is not. If they are ever relaxed, this ADR should be reopened.

## Consequences

**Good**

- One toolchain, one test framework, one lint configuration, one dependency graph.
- Shared contracts make a status-code change a single-file change.
- Hiring and onboarding target one language.

**Costs**

- Money safety is achieved by discipline plus tooling rather than by the type system alone. The tooling is in place, but it is our tooling to maintain.
- Node is single-threaded per process. Irrelevant for I/O-bound request handling; CPU-heavy work (PDF rendering, bulk selection) goes to `apps/worker` rather than blocking the API.
- We own a Java service anyway, so the team needs some Java competence regardless.

## Alternatives considered

**Java/Spring throughout.** `BigDecimal` for free and a single stack with Flowable. Rejected: it forks the language against DynaForms and the SPA, forces a re-implementation of form validation, and buys one property that ADR-007 already delivers.

**Java for the calculation service only, TypeScript elsewhere.** Rejected: introduces a second language, a second deployable and a serialisation boundary in the highest-risk part of the system. Revisit only if ADR-007's controls prove insufficient.

**Go, .NET.** Neither shares a language with the form engine or the front end, which is the main thing being optimised for.
