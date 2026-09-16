# ADR-003: Keycloak for authentication; authorisation stays ours

**Status:** Accepted
**Date:** 2026-10-01
**Plan reference:** V2 sections 2.5, 6.1

## Context

The system has officers, supervisors, approvers, auditors, administrators and
(from Phase 6) taxpayers. Tax authorities commonly require on-premises
deployment and federation to an existing directory.

## Decision

**Split authentication from authorisation.**

- **Authentication is Keycloak's.** Password policy, MFA, token issuance and
  rotation, session management, account recovery, lockout, federation. The
  system never stores a password.
- **Authorisation is ours.** Roles, permissions, menus, record-level scoping and
  delegation are domain concerns and live in the `platform` schema.

Our services validate the JWT (signature, expiry, audience), extract subject,
username and role claims, and populate a request context. Every decision about
what that identity may do is made by our code against our data.

### Why not build authentication

Weeks of work, a large security blast radius, no product differentiation, and a
category of vulnerability we would then own forever.

### Why not use Keycloak for authorisation too

Three reasons:

1. **Record-level scoping is domain logic.** "An assessor sees their own and
   their team's cases; a taxpayer sees only their own" cannot be expressed as a
   token claim without putting case ownership in the IdP.
2. **Delegation has domain semantics** — a validity window, a reason, an audit
   trail, and a rule that the delegate is not the delegator.
3. **The role model must survive an IdP change.** A customer may federate to
   their own directory with its own group structure. Role codes are mapped at
   the boundary; the domain is unaffected.

## Consequences

**Good**

- No password handling in our codebase.
- MFA and federation are configuration.
- Authorisation is testable without an IdP: the RBAC matrix tests inject a
  request context directly.

**Costs**

- Another service to deploy, operate and back up.
- Local development needs Keycloak running; the realm is imported from
  `deploy/docker/keycloak/realm-tax-assessment.json` so it is reproducible.
- Role codes exist in two places (Keycloak realm roles and `platform.role`) and
  must be kept in step. The mapping is explicit and seeded by migration.

## Related

Authorisation **fails closed**: on a Redis cache miss or outage, access is
denied rather than granted. Redis is therefore a production dependency, not a
cache of convenience, and readiness reports it as a hard dependency.
