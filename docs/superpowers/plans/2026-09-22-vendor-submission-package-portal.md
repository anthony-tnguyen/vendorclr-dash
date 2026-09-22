# Vendor Submission Package Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the anonymous single-file vendor portal with the existing multi-file submission-package workflow, including safe correction replacement and optional Turnstile challenge handling.

**Architecture:** Keep `/vendor-upload/$token` anonymous and service-role-backed only after existing token validation. Extend existing package workflow read/mutation contracts for portal rendering and open-package attachment removal; reuse storage, validation, malware, rate-limit, queue, evaluation, and replacement functions. The React portal owns presentation, local upload queue, review gating, and accessible security challenge UX.

**Tech Stack:** TanStack Start/Router/Query, React 19, TypeScript, Zod, Supabase, Vitest, PGlite, Playwright, Cloudflare Turnstile.

**Spec:** `docs/superpowers/specs/2026-09-22-vendor-submission-package-portal-design.md`

## Global Constraints

- Vendors remain anonymous; every portal server operation validates the token before service-role access.
- Do not rebuild package persistence, document storage, malware scanning, or queue processing.
- Preserve `replaces_document_id` and prior package/document versions; never delete finalized evidence.
- Use existing PDF/JPEG/PNG size, MIME, signature, malware, and rate-limit controls; no browser check substitutes for server validation.
- Extraction starts only through existing queued finalization/replacement paths.
- Render Turnstile only after challenge-required and only with `VITE_TURNSTILE_SITE_KEY`; verify with `TURNSTILE_SECRET_KEY` server-side.
- Do not claim a package is compliant before evaluation finishes.
- Display project/requester/business due date only when backed by actual request data; do not call token expiry a due date.

---

### Task 1: Add package portal contracts and safe open-package attachment removal

**Files:**
- Modify: `src/workflows/submissionPackages.ts`
- Modify: `src/workflows/vendorUploadRequests.ts`
- Test: `src/tests/submission-packages.test.ts`

**Interfaces:**
- Consumes: `resolveActiveUploadRequestByToken`, `openOrGetCurrentPackage`, `fetchChecklistView`, and `DocumentKind`.
- Produces: `loadPackagePortal(token) -> PackagePortalView` and `removePackageDocument({ token, packageId, documentId }) -> { packageId, checklist }`.

- [ ] Write a failing test that loads the token's open package with real checklist rows and attached document id/name/kind/processing status.
- [ ] Write failing tests that removal detaches exactly one `package_documents` row, retains its `vendor_documents` record, and rejects a different-token, finalized, or superseded package.
- [ ] Run `bun run test src/tests/submission-packages.test.ts`; confirm the tests fail because the contracts are absent.
- [ ] Implement `PackagePortalView`, `loadPackagePortalHandler`, and `removePackageDocumentHandler`. Validate token, request/package/document ownership, and `status === 'open'` before using service role to delete only the link. Return a refreshed persisted checklist.
- [ ] Run `bun run test src/tests/submission-packages.test.ts`; confirm green.
- [ ] Commit: `git add src/workflows/submissionPackages.ts src/workflows/vendorUploadRequests.ts src/tests/submission-packages.test.ts && git commit -m "feat: expose package portal contracts"`.

### Task 2: Surface Turnstile challenge-required state safely

**Files:**
- Modify: `src/workflows/uploadAbuse.server.ts`
- Modify: `src/workflows/submissionPackages.ts`
- Test: `src/tests/upload-abuse.test.ts`

**Interfaces:**
- Consumes: `CaptchaRequiredError`, `assertUploadAllowed`, and `verifyTurnstileToken`.
- Produces: stable `turnstile_required` public error metadata and a portal retry path accepting a captcha token.

- [ ] Write failing tests that a configured warning threshold yields `{ code: 'turnstile_required' }`, a server-verified response succeeds, a failed response remains challenged, and a solved response cannot exceed a hard limit.
- [ ] Run `bun run test src/tests/upload-abuse.test.ts`; confirm red for missing public metadata/retry plumbing.
- [ ] Implement typed challenge propagation without changing HMAC buckets, warning ratio, hard limits, or secret verification. Pass the response token only to existing `assertUploadAllowed` calls.
- [ ] Test a configured server secret with missing `VITE_TURNSTILE_SITE_KEY`: it remains challenged rather than being bypassed.
- [ ] Run `bun run test src/tests/upload-abuse.test.ts`; confirm existing invalid-token, upload-IP, token, company, spoofed MIME, unsupported MIME, oversize, and encrypted-PDF coverage stays green.
- [ ] Commit: `git add src/workflows/uploadAbuse.server.ts src/workflows/submissionPackages.ts src/tests/upload-abuse.test.ts && git commit -m "feat: surface upload challenge state safely"`.

### Task 3: Replace the single-file portal with package lifecycle UI

**Files:**
- Modify: `src/features/vendor-upload/VendorUploadPortal.tsx`
- Create: `src/tests/vendor-upload-portal.test.tsx`

**Interfaces:**
- Consumes: `resolveUploadToken`, `loadPackagePortal`, `addPackageDocument`, `removePackageDocument`, `finalizePackage`, and `replaceDeficientDocument`.
- Produces: four states: request context, upload, review, receipt.

- [ ] Write failing component tests for actual company/vendor/purpose/expiry, persisted required checklist, multiple drag/drop and picker files, a type select per file, per-file error/progress, removal before finalization, and review gating.
- [ ] Run `bun run test src/tests/vendor-upload-portal.test.tsx`; confirm the old one-file UI cannot satisfy the tests.
- [ ] Implement a local `QueuedFile` state (`ready | uploading | uploaded | error`) with `multiple`, existing MIME accept values, screen-reader status/errors, a real package type selector, and one mutation per file. Client size/type checks are advisory only.
- [ ] Implement review from server-refreshed checklist state. Finalize only through existing `finalizePackage`; receipt shows submitted filenames, package id, processing begun, and safe-to-close language, never compliance.
- [ ] Implement correction mode only for deficient eligible document ids; invoke existing `replaceDeficientDocument` and show replacement package version. Do not offer a whole-package re-upload.
- [ ] Run `bun run test src/tests/vendor-upload-portal.test.tsx`; confirm green.
- [ ] Commit: `git add src/features/vendor-upload/VendorUploadPortal.tsx src/tests/vendor-upload-portal.test.tsx && git commit -m "feat: replace vendor portal with package flow"`.

### Task 4: Add accessible conditional Turnstile widget

**Files:**
- Create: `src/features/vendor-upload/TurnstileChallenge.tsx`
- Modify: `src/features/vendor-upload/VendorUploadPortal.tsx`
- Modify: `src/tests/vendor-upload-portal.test.tsx`

**Interfaces:**
- Consumes: `turnstile_required` and `VITE_TURNSTILE_SITE_KEY`.
- Produces: `TurnstileChallenge({ siteKey, onToken, onError })` with no secret exposed.

- [ ] Write failing tests that the labelled security-verification region renders only after challenge-required, gives token expiry/error feedback with `aria-live`, and gives an accessible retry/contact fallback when site key is absent.
- [ ] Run `bun run test src/tests/vendor-upload-portal.test.tsx`; confirm red.
- [ ] Load Cloudflare's widget script once, reset it after token expiry/error, preserve focus and label the group. Store only its response token and retry the blocked operation with that token.
- [ ] Ensure missing-site-key or widget failures remain blocked and do not trigger an unchallenged retry.
- [ ] Run `bun run test src/tests/vendor-upload-portal.test.tsx src/tests/upload-abuse.test.ts`; confirm green.
- [ ] Commit: `git add src/features/vendor-upload/TurnstileChallenge.tsx src/features/vendor-upload/VendorUploadPortal.tsx src/tests/vendor-upload-portal.test.tsx && git commit -m "feat: add vendor portal turnstile challenge"`.

### Task 5: Add database and browser evidence

**Files:**
- Modify: `src/tests/submission-packages.test.ts`
- Modify: `supabase/tests/submission-packages.test.ts`
- Create: `e2e/vendor-submission-package.spec.ts`
- Modify: `e2e/helpers.ts` only if a reusable anonymous-token fixture is necessary

- [ ] Write a failing database test proving a correction creates a new document with `replaces_document_id`, retains the prior document/package, copies unaffected links, and enqueues only the replacement document.
- [ ] Run `bun run db:verify --run supabase/tests/submission-packages.test.ts`; confirm red until the fixture asserts the desired historical state.
- [ ] Add primary Playwright journey: anonymous vendor sees company/project when available/checklist, supplies COI and endorsement, assigns types, reviews, finalizes, and sees a reference id.
- [ ] Add correction Playwright journey: a correction link permits exactly the deficient file replacement and receives a versioned confirmation.
- [ ] Gate live e2e setup behind explicit environment variables; preserve a local/mockable route test so skips are explicit rather than false passes.
- [ ] Run `bun run test src/tests/submission-packages.test.ts && bun run db:verify && bun run e2e -- e2e/vendor-submission-package.spec.ts`; confirm green or explicitly configured skips only.
- [ ] Commit: `git add src/tests/submission-packages.test.ts supabase/tests/submission-packages.test.ts e2e/vendor-submission-package.spec.ts e2e/helpers.ts && git commit -m "test: cover vendor submission package journeys"`.

### Task 6: Update truth documentation and complete release checks

**Files:**
- Modify: `roadmap.md`
- Modify: `docs/product/action-truth-inventory.md`
- Modify: `supabase/README.md`
- Modify: `docs/operations/provider-setup.md`
- Modify: `.env.example` if it lacks `VITE_TURNSTILE_SITE_KEY` documentation

- [ ] Write/update a failing truth-inventory assertion that the portal is not documented as single-file-only.
- [ ] Run `bun run test src/tests/production-action-truth.test.tsx`; confirm red before updating source-of-truth copy.
- [ ] Document the real package lifecycle, queue boundary, anonymous token model, correction lineage, current Stage 4 blocker/state, and exact external Turnstile configuration. State that keys are unconfigured unless environment inspection proves otherwise.
- [ ] Run `bun run typecheck`, `bun run lint`, `bun run format:check`, `bun run test`, `bun run db:verify`, `bun run build`, and `bun run e2e` in that order. Record each exit code and segregate live/key-gated verification from local evidence.
- [ ] Run `git diff --check`, inspect `git status --short`, and commit docs with `git add roadmap.md docs/product/action-truth-inventory.md supabase/README.md docs/operations/provider-setup.md .env.example && git commit -m "docs: document package vendor portal"`.

## Plan self-review

- Spec coverage: Tasks 1-2 cover server contracts and security; Tasks 3-4 cover multi-file UX, lifecycle, confirmation, correction, and Turnstile; Task 5 covers database/E2E evidence; Task 6 covers required docs and full verification.
- Placeholder scan: no unresolved placeholders; every task names files, contract/test behavior, commands, and a commit boundary.
- Type consistency: `PackagePortalView`, `loadPackagePortal`, `removePackageDocument`, and challenge metadata are defined before UI use; link detachment is distinct from `vendor_documents` deletion and correction replacement.
