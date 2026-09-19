# Restore the boxed compliance badge style on the Vendors roster

The uploaded screenshot shows the older look: a single bordered strip split into five
equal cells, each with a status icon above a short code and a soft colour fill
(green, amber, red, blue). The Vendors roster currently shows five loose pill-shaped
chips instead. This change puts the boxed strip back on the Vendors page while keeping
every label exactly as it reads today.

## What changes

- The compliance strip on each Vendors roster row becomes one bordered box divided into
  five equal cells with hairline dividers, matching the screenshot.
- Each cell shows the same status icon set as the screenshot: a check for compliant, a
  clock for expiring or in review, a warning triangle for missing or expired.
- Each cell keeps its current wording — COI, Add Ins, WOS, Lien Waiver, REN — with no
  text changes anywhere.
- Cell background colours keep using the existing status colours (green, amber, red,
  blue soft tints).
- The vendor detail page keeps its current expanded layout; only the roster rows change.

## Technical notes

- `src/components/compliance/ComplianceRail.tsx`: the `variant="row"` branch renders
  the boxed grid instead of mapping over `ComplianceBadge`. Reuse the existing
  presentation from `ComplianceMatrix.tsx` (grid-cols-5, bordered container, per-cell
  `statusStyles`/`statusIconStyles`, `StatusIcon`), but label cells with
  `COMPLIANCE_SHORT` so current wording is preserved rather than the matrix's
  abbreviations.
- Extract the shared icon and status-colour maps out of `ComplianceMatrix.tsx` into a
  small shared module so both components stay in sync; `ComplianceMatrix` behaviour and
  its `AI`/`LW` labels are unchanged.
- Keep the existing accessibility contract untouched: `aria-label` on the container,
  per-cell `role="status"` with the full "requirement: status, dated …" label, and the
  `data-status` / `data-requirement` attributes tests rely on.
- Long labels ("Lien Waiver") in narrow cells: allow wrapping and keep the strip
  full-width in the table cell so the row stays readable on small screens.

## Verification

- Run the app test suite (the compliance and page-behaviour tests assert on
  `data-status` / accessible names, which stay the same).
- Screenshot `/dashboard/vendors` and compare against the uploaded reference.
