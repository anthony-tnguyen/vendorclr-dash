# Account termination

Status: Task 12 (data lifecycle - Engineer A slice).

<!-- PENDING LEGAL/PRODUCT APPROVAL -->

This document describes the broader process around ending a customer
relationship - distinct from the immediate technical deletion
`customer-deletion.md` covers. Ending a relationship and destroying the
data are two different decisions with two different timelines; conflating
them risks either deleting data a customer still has a notice period to
retrieve, or holding a churned customer's data indefinitely with no process
that ever revisits it.

**The specific notice period, grace-period length, and what exactly
triggers deletion below are all PROPOSED and pending counsel/product-owner
approval** - same constraint as `data-retention.md`. Nothing here may be
communicated to a customer as VendorClr's actual policy until approved.

## Proposed stages

1. **Termination decision** - the account is ending, whether by customer
   choice (cancellation) or VendorClr's own decision (e.g. non-payment,
   contract end). This project currently has no billing/subscription
   cancellation flow in the codebase (`companies.plan` is stored, but
   nothing automates a plan-driven termination) - this stage today is
   necessarily a manual, human-driven decision recorded outside the app.

2. **Notice period** (<!-- PENDING LEGAL/PRODUCT APPROVAL - proposed length only -->
   e.g. 30 days). During this window:
   - The account may remain accessible (read-only or fully functional,
     pending approval of which) so the customer can retrieve anything they
     need themselves, in addition to (not instead of) an operator-run
     `export-company.ts`.
   - No deletion occurs. This is a distinct window from any post-deletion
     retention window `data-retention.md` describes for already-deleted
     data.

3. **Data retention during the grace period** - during the notice period,
   the company's data is retained exactly as it exists today; nothing in
   this codebase currently changes access/retention behavior based on
   termination status (there is no `companies.status` or similar column -
   see `src/data/db-types.ts`). If a "read-only/suspended" state is wanted
   as part of an approved termination process, that is new schema/product
   work this task does not implement (see the plan's own scope boundary:
   this task does not add tables/columns).

4. **What triggers actual deletion** - per the approved workflow only:
   explicit sign-off (matching `customer-deletion.md`'s second-approver
   requirement) after the notice period elapses with no retrieval request
   or reversal of the termination decision. Deletion is never automatic or
   scheduled by this codebase (see `data-retention.md`'s "What this
   document does NOT do") - it always goes through the manual
   `scripts/delete-company.ts` workflow with all four required
   confirmations.

## What already exists to support this process

- `scripts/export-company.ts` / `customer-export.md` - giving the customer
  (or VendorClr, for its own records) a complete export before or during
  the notice period.
- `scripts/delete-company.ts` / `customer-deletion.md` - the actual
  deletion, once approved, at the end of the process.
- `audit_log` / `audit_snapshots` - already records account-scoped activity
  and would be the natural place to record a termination decision itself as
  an auditable event, if/when that's wired up (not currently implemented -
  no `account_terminated`-style `audit_log.action` value exists yet; widening
  its CHECK constraint, the same pattern
  `20260903000100_upload_request_cancellation.sql` used for
  `upload_request_cancelled`, is how a future task would add one).

## Open items for legal/product

- Confirm the notice period length (or whether one is required at all,
  contract-by-contract).
- Decide whether a "terminated, pending deletion" account state needs new
  schema (this task deliberately does not add it - see scope note above).
- Decide who the required "second approver" for a termination-triggered
  deletion should be by role (not just "any second person"), and whether
  that differs from an ad-hoc deletion request.
