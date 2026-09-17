# Data retention

Status: Task 12 (data lifecycle - Engineer A slice).

<!-- PENDING LEGAL/PRODUCT APPROVAL -->

**Every specific retention period in this document is a PROPOSED default,
not a decided policy.** This project has no approved legal text on data
retention (see the plan's own Task 12 constraint: "Obtain approved legal
text from counsel/product owner; engineering must not invent warranty,
privacy, retention or DPA commitments"). Nothing below may be presented to a
customer, in a privacy policy, DPA, or support conversation, as VendorClr's
actual retention commitment until counsel/the product owner has reviewed
and approved it. This document exists so that review has a concrete
starting point grounded in what the schema actually stores, not so
engineering can quietly ship a retention policy by writing it into a
runbook.

## Why these categories

The categories below mirror what this codebase's schema actually
distinguishes (see `src/data/db-types.ts` and `supabase/migrations/`), not
an abstract data-classification exercise: each one is a real table or
storage bucket with its own lifecycle already touching this code.

## Proposed default periods

<!-- PENDING LEGAL/PRODUCT APPROVAL - every period below is a strawman -->

| Category                                                                                                                         | What it is                                                                                                                                         | Proposed default retention                                                                                                                                                                                                                                                                                                                                                                                                                                               | Why this shape (not this number)                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source documents (`vendor_documents` rows + the underlying storage object in the `vendor-documents` bucket)                      | The certificates of insurance and related files a vendor actually uploaded.                                                                        | **Proposed: retained for the life of the account, plus N years after account termination** (insurance-compliance records in construction commonly need multi-year retention to support an audit or claim raised well after a policy period ends - N is deliberately left as a variable pending counsel's input, not asserted here as a specific number).                                                                                                                 | These are the actual evidentiary record a compliance program exists to produce. Deleting them early defeats the product's purpose; deleting them at all requires the approval workflow in `customer-deletion.md`.                                                                          |
| Derived extractions (`document_extractions`, and the legacy `parsed_data`/`extraction_confidence` columns on `vendor_documents`) | Anthropic-extracted structured data (policy numbers, limits, dates) read out of a source document - see `src/workflows/documentExtraction.ts`.     | **Proposed: same retention as the source document it was derived from** - deleting one without the other leaves either an orphaned interpretation with nothing to re-verify it against, or a document nobody can search/filter by its extracted fields.                                                                                                                                                                                                                  | Derived data has no independent evidentiary value once separated from its source; there is no reason for its retention window to differ from the document's.                                                                                                                               |
| Audit trail (`audit_log`, `audit_snapshots`)                                                                                     | Who did what, when, to which compliance record - see `supabase/migrations/20260902000900_audit_log.sql` and Task 11b's audit snapshot aggregation. | **Proposed: retained for the life of the account, plus N years after termination** (an audit trail's value is specifically in outlasting the events it records, for the same multi-year-liability reasoning as source documents).                                                                                                                                                                                                                                        | An audit log that is deleted before a document it recorded activity on defeats the log's purpose. This category's retention should never be shorter than the compliance data it audits.                                                                                                    |
| Email records (`email_outbox`, `email_delivery_events`, `suppressed_recipients`)                                                 | Send attempts, delivery/bounce webhooks, and the bounce-driven suppression list (Task 3-era phases).                                               | **Proposed: a much shorter window than the above** (e.g. low-single-digit years, or even months for raw delivery-event payloads) - these are operational/deliverability records, not the compliance evidence itself. `suppressed_recipients` should likely persist independently of the rest of a company's data, since its purpose (never re-emailing a bounced/complained address) doesn't expire with a company relationship the way the underlying policy data does. | Distinguishing these from source documents/audit trail matters because keeping years of raw webhook payloads has no compliance-evidentiary benefit and is pure liability/storage cost.                                                                                                     |
| Backups (Supabase point-in-time recovery / any exported snapshot)                                                                | Database backups the platform (Supabase) and/or the operations team maintain.                                                                      | **Proposed: bounded by Supabase's own PITR window on whatever plan the live project is on** (this document does not assert what that window currently is - confirm against the live project's actual plan before relying on a number here), plus a separate, shorter policy for any ad-hoc export (see `customer-export.md`) that should not become an unmanaged second copy of customer data living indefinitely on someone's laptop.                                   | A "backup" of already-deleted customer data is itself a retention decision (a company deleted via `delete-company.ts` still exists in backups taken before the deletion, until those backups themselves age out) - this needs to be part of the same approved policy, not an afterthought. |

## What this document does NOT do

- It does not set any of the above numbers as binding. Every "Proposed"
  value needs counsel/product-owner sign-off before it appears anywhere
  customer-facing (a DPA, a privacy policy, a support answer).
- It does not wire up any automatic/scheduled deletion. `delete-company.ts`
  (see `customer-deletion.md`) requires an explicit, interactive,
  multiply-confirmed invocation every single run - it is never run
  unattended or via cron, and nothing in this codebase currently deletes
  data on a timer based on age.
- It does not cover `auth.users` - see `customer-deletion.md`'s explicit
  exclusion of login identities from any deletion this project performs.

## Next steps (for whoever picks this up with legal/product input)

1. Assign real numbers to every "Proposed" cell above, or replace them.
2. Decide whether retention is enforced automatically once approved (a
   scheduled job) or remains a manual, approval-gated action indefinitely -
   the plan's own Task 12 bullet says "Enforce scheduled deletion only
   after approval," which this document treats as not yet met.
3. Confirm the live Supabase project's actual PITR/backup retention window
   and replace this document's placeholder language with the real number.
