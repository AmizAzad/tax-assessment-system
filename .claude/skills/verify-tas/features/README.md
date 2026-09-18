# Feature map

What a user of this system can actually do, and how to prove each one still
works. Maintained alongside the app: a feature that moved and was not updated
here will be verified against a screen that no longer exists.

Every file answers the same four questions — what it is, how a user reaches
it, how to drive it, what end state proves it.

| Feature | Covering spec | Prove it when you touch |
| --- | --- | --- |
| [case-lifecycle](case-lifecycle.md) | `01-lifecycle.spec.ts` | case status, transitions, calculation, approval routing, notices |
| [role-separation](role-separation.md) | `02-roles.spec.ts` | permissions, navigation, record scoping, the portal boundary |
| [register-and-export](register-and-export.md) | `04-register-and-export.spec.ts` | grid definitions, sort and filter keys, CSV export |
| [taxpayer-portal](taxpayer-portal.md) | `05-portal.spec.ts` | anything a taxpayer can see, redaction, plain-language surfaces |
| [forms-and-modeller](forms-and-modeller.md) | `06-journey-and-modeller.spec.ts` | form templates, the builder, BPMN definitions and validation |

Not covered here, and worth knowing: `03-ui-contracts.spec.ts` holds the
cross-cutting contracts — button contrast, skip link, focus visibility, and
money rendered digit for digit. Touching shared styling or the money pipe means
running that one too.

Coverage is honest, not complete: performance, accessibility audit and the
second-jurisdiction proof are exercised by hand today. `docs/testing.md` states
the gaps rather than papering over them.
