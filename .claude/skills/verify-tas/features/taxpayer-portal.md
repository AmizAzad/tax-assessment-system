# Taxpayer portal

The one surface outside the authority. Everything here is a boundary: what a
taxpayer sees, in what language, and what they are refused when they go
looking.

## Sub-features

- A taxpayer's own assessments, in plain language rather than officer shorthand.
- The officer's working papers are never shown.
- Another taxpayer's case cannot be reached by editing the address.
- The officer register refuses a taxpayer outright.

## How to get to it (user POV)

Sign in as `acme-finance` / `password` — the only non-officer account. The
portal is what that account lands on; there is no officer navigation to hide.

## Driving it with Playwright

`apps/web/e2e/05-portal.spec.ts`.

```bash
npx playwright test apps/web/e2e/05-portal.spec.ts
```

Two of the four tests drive **refusals**, by navigating to an address the
account was never offered. Keep that shape: proving the link is absent is not
proving the door is locked.

## Gotchas

- Plain language is a product requirement here, not decoration. A status code
  leaking onto the portal as `UNDER_REVIEW` is a defect even though it renders.
- Redaction lives in `apps/api/src/platform/audit/redaction.ts`. A new field on
  a portal response is a redaction question before it is a rendering question.
- The refusal must come from the server. A guard that only hides the route in
  the Angular router passes a screenshot and fails a curl.
- `acme-finance` is excluded from `OFFICERS` in `roles.ts`; a loop over `ROLES`
  that forgets this will "prove" the taxpayer can use officer screens.
