# Review of #84 ("Other" vendor trade) and follow-ups

## Review result: merged cleanly

"Other" is now the last option everywhere you pick a trade when adding a vendor:

- **Add vendor form** (Vendors page): shows "Other".
- **Add vendors from COIs**: the trade dropdown on each certificate shows "Other".
- **CSV vendor import**: a row with trade "Other" is accepted.
- **Database rule**: the new migration allows "Other" for vendors and for project
  assignments. Its note says the same change was already applied to the live database.
- Reports and the vendor pages just show whatever trade is saved, so they handle
  "Other" without changes. Demo data was left as it was.

## One gap found (not a dropdown today)

When you **assign a vendor to a project** (project page, "Trade" field), trade is a
free-text box. But the database only accepts the nine fixed trades. If someone
types "Plumbing", or even "electrical" in lowercase, the save fails with an error.

## Proposed fixes

1. Turn the project-assignment "Trade" box into a dropdown with the same nine
   trades, "Other" last, plus a "Not set" choice because that field can be left blank.
2. Keep one shared trade list and have the add-vendor form, COI import and project
   assignment all use it, so adding a trade later is a single change. The CSV
   import list stays separate but is already checked against the shared one.
3. Add a test confirming the project-assignment dropdown offers "Other" and saves it.

## Technical details

- `src/workflows/coiIntakeMapping.ts` `VENDOR_TRADES` becomes the single source.
  `VendorForm.tsx` imports it instead of its local `trades` array.
  `ProjectDetailPage.tsx` swaps the `assignment-trade` `<input>` for a `<select>`;
  an empty value is still saved as `null`.
- No database or migration changes.
