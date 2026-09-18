# Register and export

The case register is the configuration story made visible: the columns come
from `grid_definition` rows, not from a list in the front end, and the same
resolution governs sorting, filtering and what leaves as a CSV.

## Sub-features

- The register draws the columns the **server** configured, in the configured order.
- Sorting by a column the register offers.
- Filtering, including the empty-result message.
- Export of what is on screen as a CSV the browser actually receives.
- A taxpayer is not offered the export at all.

## How to get to it (user POV)

Sign in as `assessor` or `supervisor`, then **Cases**. Column headers sort;
the filter bar narrows; the export control is in the register toolbar.

## Driving it with Playwright

`apps/web/e2e/04-register-and-export.spec.ts`.

```bash
npx playwright test apps/web/e2e/04-register-and-export.spec.ts
```

The download assertion uses Playwright's `waitForEvent('download')` — proving
the browser received a file, not that a route returned 200.

Changing which columns exist means changing a `grid_definition` seed or
migration **and** the `SORTABLE` allowlist in
`apps/api/src/tax-assessment/case/register.source.ts`. The spec exists to catch
the half of that pair somebody forgot.

## Gotchas

- `SORTABLE` is the ADR-016 allowlist. A sort key that is not in it is refused
  by design; adding a column to the UI without adding the key produces a header
  that sorts nothing.
- Interpolating a caller-supplied sort straight into SQL will fail
  `npm run guards` (`sql-interpolation`). Map it through `SORTABLE`, as
  `orderBy()` already does.
- The register is scoped per caller (`registerScopeClause`). A count that looks
  wrong is usually correct scoping, not a filter defect — check who you signed
  in as before chasing it.
- `npm run load:seed` fills the register with 920k cases. Useful for
  performance work, disruptive to everything else; ask before running it.
