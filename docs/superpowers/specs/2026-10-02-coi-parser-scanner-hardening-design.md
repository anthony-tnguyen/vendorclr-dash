# VendorClr COI Parser and Free Scanner Hardening Design

**Date:** 2026-10-02

**Repositories:** `vendorclr-dash`, `vendorclear`

## Objective

Make the public COI Fix-It Scanner use the production parser contract without
creating runtime coupling between the public tool and paid document processing.
The system must prefer an explicit review state over either a false compliance
pass or an unsupported factual deficiency. The existing Requirements Builder
to Scanner to Correction Generator journey remains intact.

## Current-state findings

The paid dashboard owns the strongest parser implementation in
`src/workflows/documentExtraction.ts` and
`src/workflows/insuranceExtractionSchema.ts`. Equivalent Deno copies are used
by `process-document-jobs` and `retry-failed-documents`, but their synchronization
is documented rather than enforced. The public `analyze-coi` function contains
a fourth, weaker copy of the prompt and schema behavior.

The public function currently parses model text with `JSON.parse()` and a type
assertion. It does not normalize policy synonyms or validate the result with the
production `InsuranceExtractionSchema`. Its scanner mapper then marks every
endorsement requirement as attached when the policy has any endorsement form.
Thus a readable `CG 20 10` can incorrectly clear Waiver of Subrogation or
Primary & Noncontributory.

The re-check path has a separate P0 defect: a real parsed upload is passed to
the sample-only `applyCorrectionToExtraction()` helper. That helper fabricates
Additional Insured, Waiver, certificate-holder, and CG-form data.

The UI retains the first result as the action source after a re-check, and the
correction handoff collapses unknown states into established deficiencies. The
stored scan/report rows lack complete parser provenance and report lineage.
There is no conservative route from public scanner feedback into the existing
reviewer-edit and golden-case workflow.

## Architectural decision

`vendorclr-dash` remains the canonical parser-contract owner. The contract will
be expressed as environment-neutral source containing:

- provider and model identifiers;
- parser, schema, and prompt versions;
- policy vocabulary and synonym normalization;
- the complete extraction shape and strict validation behavior;
- the production system prompt and critical extraction rules;
- confidence thresholds and parser response handling.

A deterministic synchronization script will generate or copy the runtime
adapters used by the Node/Cloudflare workflow, both Supabase Deno workers, and
the `vendorclear` free-scanner function. Runtime-specific code may differ only
in imports, byte conversion, and request/response plumbing. It may not redefine
the model, prompt, schema, versions, normalizer, or validation rules.

Each generated contract carries a stable SHA-256 fingerprint calculated from
the canonical semantic inputs. Repository checks will fail when:

- a checked-in generated copy does not match generator output;
- model, prompt, schema, versions, or critical rules differ;
- production, retry, and free-scanner behavior fixtures return different
  normalized results for the same raw model responses.

`vendorclear` will include a cross-repository drift workflow that checks out
`vendorclr-dash` and runs the canonical synchronization check. This intentionally
avoids a runtime network hop, shared secret, package registry, or parser-service
availability dependency. Coordinated parser changes must update the canonical
source first, regenerate all consumers, and pass both repositories' drift tests.

The concrete source layout is:

- `vendorclr-dash/src/workflows/coiParserContract.ts`: canonical Node/Cloudflare
  contract and source used by application tests and the eval harness;
- `vendorclr-dash/supabase/functions/_shared/coiParserContract.ts`: generated
  Deno adapter imported by both processing workers;
- `vendorclear/supabase/functions/_shared/coiParserContract.ts`: generated Deno
  adapter imported by `analyze-coi`;
- `vendorclr-dash/scripts/sync-coi-parser-contract.ts`: the only generator and
  checker for the generated adapters.

The generator changes only the Zod import specifier required by each runtime;
the semantic source is otherwise identical. The two dashboard Edge Functions
stop carrying their own prompt/schema copies and import the shared generated
module. The public function contains only request validation, rate limiting,
the provider call, consumer mapping, and response plumbing.

The cross-repository workflow compares the free-scanner fingerprint against the
current canonical default branch, not merely a permanently pinned historical
commit. A coordinated parser change therefore cannot leave either repository
green while the public scanner remains on the previous contract. During review,
the workflow can be dispatched with the paired dashboard branch SHA; after
merge it checks the dashboard default branch.

## Canonical parser lifecycle

Every real parser call follows one sequence:

1. Build the model request from canonical model, effort, prompt, and JSON shape.
2. Reject provider refusal, missing text, and transport errors.
3. Strip an optional JSON code fence and parse JSON safely.
4. Normalize recognized policy-type synonyms.
5. Validate the complete value with `InsuranceExtractionSchema.safeParse()`.
6. Reject malformed or incomplete output without producing scanner findings.
7. Route low overall confidence to a review-required analysis state.
8. Map only the validated `InsuranceExtraction` into a consumer-specific shape.
9. Return canonical parser metadata with the mapped result.

The free scanner response is an envelope containing `extracted` and
`parserMetadata`; it is not a bare, unversioned extraction. The browser still
validates this envelope at its trust boundary. A parser validation failure is a
service/review error and cannot enter compliance evaluation.

Parser metadata contains `provider`, `model`, `parserVersion`, `schemaVersion`,
`promptVersion`, `contractFingerprint`, `analysisMode`, and `createdAt`. Sample
and mock analyses use explicitly different deterministic metadata and can never
be confused with a real provider call.

## Conservative confidence behavior

The mapped scanner extraction retains overall confidence and the analysis
review state. A low-confidence value cannot produce a compliance pass merely
because it is non-null. Numeric limits, dates, certificate-holder matches, and
coverage-presence checks require sufficient evidence. Low-confidence or
schema-unknown inputs become `could_not_determine` or
`verification_required`, never `pass`.

The mapper must not manufacture confidence at the field level. Until the
canonical parser provides independent field confidence, field confidence is
bounded by overall confidence and the presence of direct evidence.

## Endorsement evidence model

Endorsements are classified by normalized form identity before scanner rules
run. Normalization removes punctuation and edition suffix noise while retaining
the base ISO form number. The initial conservative mapping is:

| Normalized form | Supported requirement |
| --- | --- |
| `CG 20 10` | Additional Insured, ongoing operations |
| `CG 20 37` | Additional Insured, completed operations |
| `CG 24 04` | Waiver of Subrogation |
| `CG 20 01` | Primary & Noncontributory |

No unknown form satisfies a requirement. A recognized form supports only its
mapped requirement. The scanner records requirement-specific evidence with the
matched form identities and one of these states:

- `verified_form`: a recognized supporting form was read;
- `wording_only`: certificate wording/checkbox exists without a supporting
  form;
- `ambiguous_form`: a form exists but cannot conservatively be matched;
- `no_evidence`: neither wording nor relevant form was found.

Only `verified_form` is eligible for `pass`. `wording_only` and
`ambiguous_form` produce `verification_required`; `no_evidence` produces
`not_found`. Additional Insured requirements distinguish general, ongoing, and
completed-operations evidence. A combined certificate checkbox cannot prove
both ongoing and completed operations.

## Re-check behavior and active state

`applyCorrectionToExtraction()` is restricted to an explicitly named
sample/demo re-check function. A real file follows:

`file -> analyzeCoiDocument -> validated extraction -> scanner evaluation`

There is no correction mutation between parsing and evaluation. Tests inject
real-mode parser results missing each sensitive field and prove that re-check
does not add AI, WOS, certificate-holder, Primary & Noncontributory, or CG-form
evidence.

The page defines `activeResult = recheck?.result ?? result`. Current summary,
findings, action plan, open count, correction CTA visibility, correction
prefill, and downloadable current report use `activeResult`. The immutable
original remains the baseline for before/after comparison, audit history, and
the re-check diff.

Each successive re-check compares with the immediately previous active result,
while retaining the root result. This prevents a third scan from repeatedly
comparing against stale first-scan findings.

## Safe Correction Generator handoff

The handoff maps explicit scanner semantics rather than finding keys alone.
Issue types will distinguish at least:

- GL missing, below limit, and unreadable limit;
- Auto missing, below limit, and unreadable limit;
- expired, future-effective, and unreadable policy dates;
- confirmed certificate-holder mismatch and unreadable holder;
- endorsement absent, wording without support, and ambiguous supporting form.

Only `below_requirement` creates a low-limit claim. Only `expired` creates an
expired-certificate claim. Only a readable non-matching holder creates a wrong
holder claim. Unknown states request clarification, a clearer certificate, or
supporting documentation. Generated vendor/broker language must not state a
deficiency more strongly than the scanner established.

## Persistence and report lineage

A new forward-only `vendorclear` migration extends scanner persistence. Existing
migrations are not edited. Real scan rows store the canonical parser metadata
in explicit columns as well as in the report payload where useful.

Report lineage uses a parent chain plus a root reference:

- original report: `recheck_of = null`, `root_report_id = null`, sequence `0`;
- first re-check: `recheck_of = original`, `root_report_id = original`, sequence
  `1`;
- later re-check: `recheck_of = previous report`, `root_report_id = original`,
  sequence incremented by one.

The UI awaits the original report insert before enabling re-check persistence
and retains the most recent report ID. Foreign keys prevent references to
nonexistent reports. The report snapshot preserves requirements, extraction,
findings, metadata, and analysis time so parser versions can be compared later.

## Public parser feedback

After a real scan, users can answer “Did we read this COI correctly?” with
`looks_correct` or `incorrect`. Incorrect feedback supports structured edits to
canonical parser-readable fields. The client calculates a display diff, but
the server revalidates the full corrected extraction and derives the stored
field diffs; it does not trust a client-supplied diff.

`scanner_parser_feedback` is append-only and separate from production truth.
It stores the scanner session/report, canonical parser metadata, original and
corrected extraction snapshots, server-derived diffs, feedback source,
`pending | verified | rejected` status, verifier attribution, consent state,
and timestamps. Anonymous clients cannot select, update, verify, or directly
insert rows. A rate-limited Edge endpoint validates the request and writes with
the service role. Staff verification remains a separate privileged operation.

Anonymous “looks correct” feedback is a product signal, not verified ground
truth. Incorrect feedback remains pending until staff review. Only a verified
correction with an available source document is eligible for golden-case
capture.

## Raw-document privacy

Raw uploads continue to be discarded after parsing by default. Parser-
improvement retention is controlled by a separate, unchecked-by-default consent:

“Allow VendorClr to securely retain this document to improve COI parsing
accuracy.”

It is independent from marketing/newsletter consent. When consent is absent,
the feedback row contains no raw-document object reference. When present, the
feedback endpoint re-applies MIME and size checks and stores the file in a
private bucket under a server-generated key. There is no anonymous read policy;
staff access uses the existing privileged backend boundary. Withdrawal and
retention-period operations can delete the private object without deleting the
audit-safe structured feedback row.

## Security and abuse controls

The public parser retains the 15 MB cap, accepted PDF/PNG/JPEG allow-list,
provider-key isolation, and service-role-only database access. Neither the
Anthropic key nor the service-role key is returned or bundled into the browser.

Rate-limit failures no longer silently disable protection. Missing limiter
configuration or counter failures produce a temporary service error for real
provider calls. Client identity uses the platform-provided forwarding header
accepted by the deployed Supabase environment, with spoofable values excluded
from the bucket key. Feedback submission has separate per-IP and global limits.
Error responses expose stable public codes, not provider or database details.

RLS tests prove anonymous users cannot read scanner sessions, reports, feedback,
or retained objects; cannot mark feedback verified; and cannot update another
row. Service-only functions explicitly revoke execution from `public`, `anon`,
and `authenticated` unless a narrowly scoped public wrapper performs its own
validation and rate limiting.

## Accuracy flywheel integration

The dashboard capture tooling gains a scanner-feedback source adapter. It reads
only `verified` feedback, requires a retained private source document, validates
the corrected extraction against the current canonical schema, and emits the
same golden-case layout and provenance used by reviewer edits. Provenance names
the original parser fingerprint, scanner report, feedback row, verifier, and
consent record.

The flow is therefore:

`free scan -> optional user correction -> pending feedback -> staff verification -> eligible golden case -> eval -> parser change -> synchronized consumers`

No anonymous feedback directly changes dashboard policies, production
extractions, compliance status, or golden expectations.

## Test strategy

Implementation follows red-green-refactor. Required automated coverage includes:

- malformed JSON, fenced JSON, schema-invalid data, policy synonyms, missing
  fields, and confidence routing;
- canonical contract generation and cross-consumer behavioral equivalence;
- every endorsement cross-match and unknown/ambiguous case;
- real re-check immutability and sample-only deterministic correction;
- latest re-check active state and one-current-issue correction prefill;
- every semantic Correction Generator mapping and generated wording;
- report parent/root/sequence lineage and parser provenance persistence;
- feedback validation, RLS, verification status, and consent-gated private-file
  storage;
- the complete Requirements Builder to Scanner to Correction Generator flow.

Final verification runs each repository's full unit suite, type checking, lint,
format check where configured, build, and the dashboard database/PGlite suite.
The marketing build must include SSR/prerender verification. A live Anthropic
parse is reported only if a real provider call is deliberately run with valid
credentials. Local tests, mocks, and successful compilation are never described
as live parser evidence.

Because the scanner migration remains in `vendorclear`, the cross-repository
test job applies the normal dashboard migration chain and then the new scanner
migration to PGlite before running its lineage, grant, and RLS assertions. This
tests the migration against the schema it will actually extend without copying
the migration into the dashboard repository.

## Repository ownership and delivery

`vendorclr-dash` owns the canonical parser contract, generator, production/retry
adapters, drift checks, golden-case adapter, and related tests.

`vendorclear` owns the public-scanner mapper and rules, re-check behavior,
Correction Generator handoff, active-result UI, public feedback UX/endpoint,
scanner persistence migration, privacy copy, and scanner pipeline tests.

The scanner persistence migration remains in `vendorclear` because those tables
originated there. It is not duplicated in `vendorclr-dash`. A later repository-
governance task should designate a single production migration owner and
backfill a migration ledger; that broader consolidation is outside this focused
hardening change.

The work should ship as two coordinated reviewable branches. Parser-contract
changes land first or alongside the scanner changes, and production deployment
must apply the database migration and deploy the updated Edge functions before
the new feedback UI is enabled.
