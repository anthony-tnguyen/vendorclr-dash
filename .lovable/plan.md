# Match compliance badge spacing to the reference

## Goal
Make the five compliance cells on the Vendors roster feel less cramped while preserving every existing label, status colour, icon, tooltip, and accessibility description.

## Changes
- Keep each cell at the requested 65px width and the five-cell strip at 325px before its outer border.
- Increase the row height and vertical breathing room to match the attached reference.
- Keep status icons aligned near the top of each cell, with a larger intentional gap before the centered label.
- Preserve the current labels exactly: `COI`, `Add Ins`, `WOS`, `Lien Waiver`, and `REN`.
- Limit the change to the compact Vendors roster rail; leave the vendor-detail compliance layout unchanged.

## Verification
- Compare the rendered roster rail against the reference at desktop and narrow viewport sizes.
- Confirm no label clips or wraps incorrectly and all five cells remain aligned.
- Run the compliance-rail tests, full test suite, type check, and production build.
