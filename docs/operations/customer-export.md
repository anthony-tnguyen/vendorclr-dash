# Customer data export

Status: Task 12 (data lifecycle - Engineer A slice).

`scripts/export-company.ts` produces a complete, read-only export of one
company's data: every database row it owns across every company-scoped
table, plus its private storage objects (the certificates of insurance and
related files in the `vendor-documents` bucket). It never deletes or
modifies anything - see the script's own docblock.

## When to run this

- **A customer data request** - a customer asks for a copy of everything
  stored about them (a "right to access"/data portability style request).
  This document does not assert what legal obligation, if any, requires
  VendorClr to honor such a request on what timeline - that determination
  needs counsel/product-owner input, same as everything in
  `data-retention.md`. This script is the operational capability that makes
  fulfilling such a request possible once that policy exists.
- **Offboarding** - before deleting a company's data (see
  `customer-deletion.md`), an export gives the customer (and VendorClr) a
  complete record of what existed at the moment of deletion.
- **A legal hold** - preserving a company's data outside the normal
  retention/deletion lifecycle, e.g. because of pending litigation or a
  regulatory inquiry. An export is a point-in-time snapshot suitable for
  that purpose; it does not itself implement a hold (nothing in this
  codebase prevents further writes to the live tables after an export
  runs).

## Running it

```bash
# Requires VENDORCLEAR_SUPABASE_URL and VENDORCLEAR_SERVICE_ROLE_KEY in the
# environment, pointed at whichever project (local/staging/production) you
# intend to export from - see .env.example.
bun scripts/export-company.ts <companyId> [outputDir]
```

- `companyId` - the `companies.id` (uuid) to export. Find it via the admin
  Companies screen (`src/features/admin/CompaniesPage.tsx`) or a direct
  query.
- `outputDir` - optional. Defaults to `./exports/<companyId>-<timestamp>`.

## What it produces

```
<outputDir>/
  manifest.json          # company id/name, export timestamp, per-table row
                          # counts, and storage object count/total bytes
  tables/
    audit_log.json        # one JSON file per company-scoped table (see
    vendors.json           # scripts/lib/companyScopedTables.ts for the
    ...                     # full 34-table list), each an array of every
                            # row belonging to this company
  storage/
    company/<companyId>/vendor/<vendorId>/documents/<file>.pdf
    ...                    # every object in the vendor-documents bucket
                            # under this company's prefix, at the same
                            # relative path it has in the bucket
```

`manifest.json` is the reconciliation anchor: it is what
`customer-deletion.md`'s post-deletion verification step compares against
to confirm a deletion actually removed everything it claimed to.

## What it does NOT do

- It does not export `auth.users` rows (login identities) - see
  `customer-deletion.md` for why this project treats those as out of scope
  for company-scoped operations generally.
- It does not encrypt or otherwise protect the output directory. Treat an
  export directory as containing the same sensitive data (certificates,
  contact emails, policy details) the live database does, and store/share
  it accordingly - this document does not prescribe a specific transport or
  storage mechanism, since none has been decided.
- It does not paginate or rate-limit itself beyond reading tables
  sequentially (see the script's own docblock) - it is sized for an
  individual company's data, not a bulk/all-companies export.
