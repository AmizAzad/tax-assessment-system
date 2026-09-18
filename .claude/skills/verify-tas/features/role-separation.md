# Role separation

Ten seeded accounts, nine of them officers and one a taxpayer, each seeing a
different system. The server is the control; the UI is expected to agree with
it.

## Sub-features

- Navigation per role — what each of the nine officer roles sees, and what it must not.
- A taxpayer typing an officer URL is **refused**, not shown an empty page.
- The dashboard is scoped to whoever is looking at it.
- Every officer role can sign in and reach a working screen.

## How to get to it (user POV)

Sign in as any of the roles in `apps/web/e2e/roles.ts` with password
`password`. The navigation rail is the visible surface; the invisible one is
what happens when a role pastes a URL it was never offered.

## Driving it with Playwright

`apps/web/e2e/02-roles.spec.ts` generates one test per role from `NAVIGATION`
in `roles.ts`, which declares the visible and hidden labels per role.

```bash
npx playwright test apps/web/e2e/02-roles.spec.ts
npx playwright test apps/web/e2e/02-roles.spec.ts --grep "acme-finance"
```

A new role belongs in three places at once: the Keycloak realm, the `ROLES`
list, and the `NAVIGATION` map. Added to the realm only, it is never exercised —
the kind of gap that is invisible in a green run.

## Gotchas

- Navigation agreement is a **usability** property, not the security control.
  Proving a menu is hidden proves nothing about the API; drive the route, or
  call the endpoint, to prove the refusal.
- `acme-finance` is the taxpayer. `OFFICERS` in `roles.ts` is everyone else —
  use it rather than hand-listing roles, or the next added role escapes.
- Sessions live in `apps/web/e2e/.auth/<role>.json` and are written by
  `auth.setup.ts` through the real Keycloak form. A stale realm import means
  stale sessions: delete the directory and let setup run again.
- The authorisation catalogue is refreshed at API start (`15 roles, 117
  routes`). A permission change that is not in a migration disappears on the
  next fresh database.
