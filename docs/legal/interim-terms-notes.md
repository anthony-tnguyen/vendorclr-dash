# Interim Terms and Privacy Notice - notes for counsel

Written 2026-09-24, before attorney review, at the product owner's request
(operator: Anjeko Holdings LLC, California; contact `support@vendorclr.com`;
disputes in California courts; retention stated by criteria, no fixed day
counts). The text lives in `src/features/legal/LegalPages.tsx`.

This is a stopgap, not legal advice and not a substitute for review. Its aim
is to be **accurate** (never promise what the product does not do) and
**protective** (disclaim, cap and allocate risk in the usual ways) until a
lawyer replaces or approves it.

## What the interim text is built to do

- Name the contracting party and make agreement explicit at the point of action
  (`LegalConsent` beside: create account, accept invitation, activate workspace,
  vendor upload). Footer-only links are weak evidence of assent.
- State plainly that VendorClr is a record-keeping tool - not an insurance
  agent/broker, not legal advice - that a certificate is informational and is
  not verified with the carrier, and that "compliant" means only "met the
  requirements the customer configured". This is the highest-value protection
  for this product: the realistic claim against it is "your tool said the
  vendor was compliant and the loss was not covered."
- Warranty disclaimer, damages exclusions (including uninsured/denied claims and
  vendor non-compliance), a liability cap (greater of 12 months' fees or $100),
  customer indemnity, no SLA, suspension/termination, California law and venue.
- Carve out fraud, gross negligence, willful misconduct and anything not
  limitable by law (California Civil Code section 1668 makes broader
  exclusions unenforceable).
- Privacy Notice: controller/service-provider roles, categories, providers,
  no sale/sharing, no trackers, retention criteria, California rights.

## Every factual claim and its evidence

| Claim in the text                                                         | Evidence                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| No third-party advertising or analytics trackers; no ad/analytics cookies | Grepped `src/` and the root route for analytics/ad SDKs: none                  |
| Session is stored in cookies                                              | `src/lib/supabase/client.ts` (SSR cookie storage)                              |
| Documents are sent to Anthropic; VendorClr does not train models on them  | `src/workflows/documentExtraction.ts`; no training code exists                 |
| VirusTotal gets a hash, not the file                                      | `src/workflows/malwareScanner.ts`                                              |
| IP is used in keyed-hash form for rate limiting                           | `src/workflows/uploadAbuse.server.ts`                                          |
| Company data is separated at the database level                           | RLS policies; `supabase/tests/`                                                |
| Uploaded documents are in private storage                                 | `vendor-documents` bucket is private (`scripts/smoke-production.ts` checks it) |
| Bounced/complained addresses stop receiving email                         | `suppressed_recipients` + `handle_bounce_suppression()`                        |
| No automatic deletion on a schedule                                       | `docs/operations/data-retention.md`; `delete-company.ts` is manual only        |
| Project hosted in the United States                                       | Supabase `us-east-2`                                                           |
| Staff access limited to authorized administrators                         | `platform_admins` table; `is_platform_admin()`                                 |
| Turnstile "may be shown"                                                  | Wired; site key committed, server secret still to be set in Lovable            |
| Providers listed                                                          | `docs/legal/subprocessors.md`                                                  |

## What was deliberately NOT promised

Retention or deletion day counts, a breach-notification deadline, an uptime or
support SLA, security certifications (SOC 2, ISO), encryption-at-rest claims of
our own, GDPR/UK adequacy, or that a data-processing agreement exists. Adding any
of these without the mechanism behind it turns a disclaimer into a breach.

## For counsel to look at first

1. Whether Anjeko Holdings LLC (and not a different entity) should be the
   contracting party, and whether the product should be sold under a "doing
   business as" name filed in California.
2. The liability cap and indemnity, and whether a separate order form or MSA
   should carry the commercial terms (price, term, renewal, refund) that section
   8 currently defers to "your order, invoice or written agreement".
3. Whether CCPA/CPRA applies (business thresholds), and the wording on
   service-provider status, sale/sharing and retention criteria.
4. A written data-processing agreement for customers who ask, and a real
   retention and deletion policy - then the automation to enforce it.
5. Vendor-side terms: vendors upload under a customer's request, so confirm the
   allocation of responsibility in section 4 and the customer's duty to obtain
   any needed vendor consent.
6. Insurance: whether product liability / professional (E&O) and cyber cover
   should exist; this text limits exposure but does not replace insurance.
7. Trademark and IP ownership of the VendorClr name and the logo.

## Owner's follow-ups

- Confirm `support@vendorclr.com` is a monitored mailbox; legal notices go there.
- Add a mailing address to both pages if desired.
- If a paid plan or auto-renewal is offered to consumers or small businesses,
  California auto-renewal disclosure rules may apply - ask counsel.
- Keep `EFFECTIVE_DATE` in `LegalPages.tsx` current whenever the text changes.
