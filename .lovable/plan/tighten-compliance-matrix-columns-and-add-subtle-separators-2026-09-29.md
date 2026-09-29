# Tighten compliance matrix columns and add subtle separators

## Goal
On the Compliance overview page's "Vendor compliance" matrix, make the requirement columns feel tighter and add faint vertical dividers so each requirement column reads as its own band.

## Changes (src/features/overview/OverviewPage.tsx)
- Scope: only the "Vendor compliance" table (the second table on the overview page). Leave the "Needs attention" table and all other pages unchanged.
- Tighten horizontal column spacing: reduce cell padding on the compliance column headers and cells from `px-2.5` to a smaller value so the requirement columns sit closer together. Keep the Vendor column's spacing as is so names don't crowd the left edge. Keep vertical padding unchanged.
- Add a subtle vertical separator: a faint left border on each compliance requirement column (all columns except the leading Vendor column), applied consistently to header cells and body cells so the divider runs the full table height. Use the existing muted border token at reduced opacity rather than a hard border so it reads as a subtle band edge, not a grid line.
- Do not change statuses, labels, dates, ordering, or any data logic.

## Verification
- Visual check of the matrix at desktop and narrow viewport widths — dividers align across header and rows, labels and dates do not wrap or clip.
- Typecheck and the overview/compliance-related tests.
