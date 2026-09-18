# VendorClr go-live blockers — implementation plan

The brief lists 24 items. Most of the backend exists; what is missing is the customer-facing path, plus some account/infrastructure work that has to happen outside this project. This plan groups the work into shippable stages and separates what I can build from what needs you.

## What I verified in the project today

- Settings, Reports export, and Access (invite teammate) still show "not available" outside demo mode.
- Read paths already exist for projects, assignments, requirement profiles, contacts, suppression, communications history, and all the reports named in the brief (compliance by project/trade, expiring, missing docs, deficiencies, exceptions, unresponsive, bounced, time-to-compliance, resubmissions, reviewer turnaround) plus audit snapshots.
- There is no projects page, no requirement-profile page, no contacts UI, no CSV import screen, no `/accept-invite/:token`, and no `/terms` or `/privacy` route.
- Write operations (create/edit project, assign vendor, edit profile rules, save settings) mostly need to be added alongside the new screens.

## Stage 1 — Company setup surfaces

1. **Settings**: replace the disabled form with the company's real default requirement profile — coverage types, GL each-occurrence and aggregate minimums, workers comp, auto, umbrella, professional, pollution, additional insured (overall, ongoing, completed), waiver of subrogation, primary & noncontributory, certificate holder, required endorsements. Loads real values, validates, saves, records an audit entry. Owner/risk-manager can edit; everyone else sees read-only. Reminder settings get a small dedicated table only if nothing existing holds them.
2. **Projects**: list (name, number, status, location, active vendors, compliance summary, profile) with create/edit/archive, plus a detail page showing certificate holder, profile, overrides, assigned vendors and their compliance. Assign and deactivate vendors through assignments — never by duplicating a vendor.
3. **Requirement profiles**: create, rename, edit rules, archive, set as company default, attach to a project or an assignment, manage project overrides. Existing precedence and the "always a valid default" protection are preserved.

## Stage 2 — Team access

Real teammate list, pending invites, invite with role, resend, revoke, change role, remove member, transfer ownership. Add the `/accept-invite/:token` page with expired, revoked, already-used, wrong-account, and success states, without revealing whether an unknown token exists. Remove the stale "not available" copy.

## Stage 3 — Contacts and requests

Vendor detail gains operational, broker, and secondary contacts with agency, email, phone, bounce state, and add/edit/link/unlink/role actions on the shared contact model. The document request action moves onto the multi-recipient path: pick recipients, see exactly who receives it, block or clearly flag suppressed addresses, always mint a fresh link, log the send. Adds resend with editable recipients, request history, and delivery state (delivered, bounced, complained, failed, uploaded). The legacy single-recipient path is retired.

## Stage 4 — Vendor upload portal

Rebuild the portal around submission packages: company branding, project name, requester, checklist of requested documents, multi-file selection with a document type per file, upload progress, package summary, finalize, and a receipt with a reference number and processing state. Individual deficient documents can be replaced without redoing the package. Extraction stays on the existing background queue. Turnstile challenge renders only when the existing abuse rules ask for it.

## Stage 5 — Deficiencies and exceptions

Plain-language deficiency list ("General Liability — Each Occurrence: required $2,000,000, submitted $1,000,000"), with select, send correction request to chosen recipients, generated instructions, request date, escalation level, resubmission history, and resolved state. The case stays open across resubmissions. Exception approval is limited to authorized roles and captures reason, remaining-risk acknowledgement, effective and expiration dates, optional supporting file, and internal note; it shows approver, timestamp, and active/expired state. No generic "mark compliant" shortcut.

## Stage 6 — Review editing, import, reports, legal

- Document review: view the document, edit extracted fields with changes highlighted, see shortfalls, approve or reject with reason and note, and a review history. Reviewer edits create a new revision; the model's extraction is never overwritten.
- CSV import: upload, preview, per-row/column validation, a clear preview of what will be created versus matched, confirm, execute, then a result summary with rejected rows and an error CSV download. Existing duplicate protection stays intact.
- Reports: real data for the report set above, with working server-generated CSV download, safe filenames, permission checks, and an audit event. Audit snapshot access where practical. No PDF export.
- `/terms` and `/privacy` routes linked from login, signup, the upload portal, and the app footer. Content is clearly marked as requiring your and counsel's approval — I will not invent legal commitments.

## Stage 7 — Verification

Unit, database, workflow, UI, and browser tests for each stage, including the five end-to-end journeys in the brief (company setup, vendor submission, compliance correction loop, exception, team, reporting). Finish with typecheck, lint, formatting, full test suites, production build, and a sweep for stale "demo"/"not available" copy on features that now work.

## Items I cannot complete alone

These are in the brief but depend on accounts, billing, or credentials I do not control. I will prepare everything code-side and document exact steps, then flag them as open:

- **Staging deployment and provider keys** (items 15, 16): needs a separate staging deployment plus staging Resend, Anthropic, VirusTotal, Sentry, and Turnstile credentials, and the staging vault entry that lets the four scheduled jobs authenticate.
- **Turnstile** (17): needs production and staging site/secret keys from you; the portal-side integration ships regardless.
- **Recurring backups and restore drill** (18, 19): I can add the scheduled backup job and documentation, but it needs an encrypted storage destination and database credentials stored as secrets. The restore drill needs a disposable environment.
- **Branch protection** (20): limited by your GitHub plan; documented as an external blocker unless the plan changed.

## Sequencing

Stages ship one at a time so you can review each in the live app rather than waiting for the whole thing. Each stage lists its schema impact, permission considerations, user-visible changes, tests, and remaining gaps.
