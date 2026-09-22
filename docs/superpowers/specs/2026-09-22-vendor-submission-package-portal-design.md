# Vendor Submission Package Portal Design

## Goal

Replace the anonymous, single-file vendor-upload screen with the existing
submission-package lifecycle while retaining account-free, token-authorized
access and every existing upload-security control.

## Confirmed current state

- `VendorUploadPortal` calls legacy `uploadDocumentForToken` and can accept one
  file only.
- The existing package workflow already owns package creation, document
  attachment, finalization, asynchronous job enqueueing, and replacement
  lineage: `createPackage`, `addPackageDocument`, `finalizePackage`, and
  `replaceDeficientDocument` in `src/workflows/submissionPackages.ts`.
- `resolveUploadToken` exposes company, vendor, token expiration, current
  policies, and request purpose. The persisted request has no project id,
  requester display field, or business due-date field. The portal will show
  only available real values and will not manufacture those fields.
- The package checklist is persisted in `upload_request_checklist_items`.
  The current package bootstrap contains a legacy default seed; the portal
  must display persisted rows and never embed an independent checklist.
- Server validation already performs size, MIME/signature, encrypted-PDF,
  malware, per-IP/per-token/per-company abuse controls, and Turnstile server
  verification. Extraction is enqueued at finalization, not performed in the
  browser request.

## Scope and architecture

The public route remains `/vendor-upload/$token`. A package-load server
contract will compose the existing token resolution and package APIs into a
single view model containing real request context, checklist rows, attached
open-package documents, and correction eligibility. It will continue to
manually validate the token before every service-role access; vendors do not
receive a VendorClr account or a Supabase session.

`VendorUploadPortal` becomes a stateful wizard with four screens: secure
request, upload, review, and receipt. The upload screen owns a local queue,
but files are stored only when the vendor submits each queued row. Every row
has an allowed document-kind selector populated from the package contract,
per-file upload/error/progress status, and an option to remove an unfinalized
attachment. Removal only detaches the file from the open package; it does not
delete a `vendor_documents` record or any finalized/historical evidence.

The correction view is selected only when the loaded package represents a
deficient-document correction. It exposes exactly the deficient document
slot(s), calls `replaceDeficientDocument`, and confirms the resulting package
version. The server continues to retain old `vendor_documents` and sets
`replaces_document_id`; no full re-upload is requested.

## Request context and checklist semantics

The portal header displays requesting company, vendor, concise request
purpose/instructions, and link expiry. It displays project, requester, and
business due date only if future/current request data actually supplies them;
the token's security expiry is not mislabeled as a due date.

Checklist rows come exclusively from `upload_request_checklist_items` plus
the current package documents. A row is labeled required or optional and has
one of: required, uploaded, processing, complete, or needs replacement. The
status derives from stored package/document/processing/evaluation state, not
from guessed compliance. Document labels are presentation labels for the
stored `document_kind` values; the portal does not hard-code an alternative
list of requested documents.

Finalization remains blocked by existing server-side required-checklist
validation. The confirmation says the package was received, provides the
package/reference id and submitted filenames, identifies processing as
pending/started, and explicitly says it is safe to close the page. It never
claims compliance before evaluation finishes.

## Turnstile behavior

The browser will load/render Turnstile only after a server operation returns
the existing challenge-required condition and a public
`VITE_TURNSTILE_SITE_KEY` is available. It stores the short-lived response
token in component state and resubmits it to the existing server abuse-control
contract, whose `TURNSTILE_SECRET_KEY` verification remains authoritative.

If neither secret nor site key is configured, the optional challenge is never
requested and existing rate limits still run. If a secret enables a challenge
but the site key is absent, the portal presents an accessible configuration/
retry contact state and does not bypass the challenge or rate limits. The
provider documentation will state both external configuration requirements and
will not imply configured credentials.

## Required server changes

1. Replace legacy checklist bootstrap behavior only where an actual request
   checklist exists; never overwrite configured rows. Keep a documented
   compatibility fallback for old requests that lack checklist rows until the
   request-creation owner provides a real requirement snapshot.
2. Add a token-authorized package-detail contract returning attached document
   ids, filenames, kinds, and processing/evaluation state for the selected
   package; it must perform the same token/request ownership checks as the
   existing handlers.
3. Add an open-package-only detach operation. It validates token, package and
   attachment ownership, applies the existing upload abuse path appropriate to
   a mutation, and deletes only the `package_documents` link. It must reject
   finalized or superseded packages.
4. Make challenge-required a safe, machine-readable public error/result so
   the portal can render the challenge without parsing arbitrary messages.
   Server-side verification and hard limits remain unchanged.

## Test plan

Test-first coverage will prove the new contracts cannot cross token/package
boundaries, cannot detach finalized evidence, retain a replaced predecessor,
and enqueue processing only after finalization. File tests will cover spoofed
and unsupported MIME, oversized files, password-protected PDFs, token/company
limits, invalid/expired tokens, and challenge-required/solved Turnstile paths.
Component tests will cover real checklist rendering, local removal, per-file
errors/progress, review gating, receipt wording, and accessible Turnstile
fallback. Playwright will add the primary anonymous multi-file package journey
and a correction journey; credential/environment-gated parts will be marked
explicitly rather than reported as locally exercised.

## Documentation and verification

Update `roadmap.md`, `docs/product/action-truth-inventory.md`, blocker status,
`supabase/README.md`, and `docs/operations/provider-setup.md`. Remove
single-file-only claims only after the portal itself calls the package flow.

The completion gate is fresh evidence from:

`bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test`,
`bun run db:verify`, `bun run build`, and `bun run e2e`.

Hosted configuration, real Turnstile keys, deployed migration/function state,
and credential-gated browser journeys will be reported separately from local
verification.
