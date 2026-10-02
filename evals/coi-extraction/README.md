# COI extraction accuracy eval

A measurement rig for the certificate-of-insurance parser. It runs the **real
production extractor** (`getDocumentExtractor()` in
`src/workflows/documentExtraction.ts`) against a fixed set of real
certificates whose correct answers we have verified by hand, and scores the
run field-by-field.

This is the yardstick for the _instruct → test → re-instruct_ loop: run it,
change the prompt/model/effort, run it again, keep the change only if the
number went up. Without it, every "improvement" is a guess that silently
regresses the cases you weren't looking at.

## Running it

```bash
ANTHROPIC_API_KEY=sk-ant-... bun run eval:coi
# quick/cheap pass over the first few cases:
ANTHROPIC_API_KEY=sk-ant-... bun run eval:coi -- --limit=5
# quieter output (summary only, no per-case list):
ANTHROPIC_API_KEY=sk-ant-... bun run eval:coi -- --quiet
```

It **calls the live Anthropic API and costs money** every run, and it is
non-deterministic — that is exactly why it is a manual `scripts/` tool and not
part of `bun run test` (that suite runs offline, in demo mode, deterministically,
with no API key). Reports are written to `evals/coi-extraction/reports/` (git-ignored).

## Building the golden set

Each case is a subdirectory of `cases/` containing:

```
cases/
  acme-clean-acord25/
    document.pdf        # the certificate: .pdf, .png, .jpg, or .jpeg
    expected.json       # the hand-verified correct extraction
    README.md           # (optional) notes on what makes this case interesting
```

- `document.*` — the source certificate. **Do not commit a real customer's
  COI** unless you have cleared it; prefer redacted or synthetic certificates,
  or ones you have explicit permission to store. The folder is a permanent
  record, so treat it like any other data you retain.
- `expected.json` — a full extraction object in the exact shape the parser
  returns (`InsuranceExtractionSchema`). The harness validates it against that
  schema on load, so a malformed golden file fails loudly instead of scoring
  against garbage. Fields that are genuinely unreadable on the certificate must
  be `null` — that is a real, gradeable answer, not a blank.

**Aim for ~30–50 cases that span the hard cases, not 50 clean ones:** crisp
machine-generated ACORD 25s, poor scans, handwriting, multi-policy certificates
(GL + WC + Auto + Umbrella on one form), struck-through or amended cancellation
language, split additional-insured endorsements (CG 20 10 vs CG 20 37), and
non-ACORD / junk uploads. The score is only as honest as the spread of the set.

The defaulted schema fields (`primary_noncontributory`,
`additional_insured_ongoing_operations`, `cancellation_notice_*`,
`employers_liability`, `follows_form`, `endorsement_forms`) may be omitted from
a policy and will be treated as `null`. See
`cases/example-clean-acord25/expected.json` for a worked example.

## How grading works

**Headline field accuracy** = correct fields / graded fields, matching policies
by coverage type (order-independent). Both-null counts as correct — knowing a
field is absent is a right answer.

Wrong answers are split into three kinds because they do not cost the same:

| Kind | Meaning | Why it matters |
|---|---|---|
| **miss** | truth had a value, model said `null` | conservative error; routes to review |
| **hallucination** | truth was `null`, model invented a value | the trust-killer — a confident wrong field |
| **mismatch** | both had values, they differ | wrong reading |

String fields (carrier, insured/holder names and addresses) are matched
fuzzily (case/whitespace/punctuation-insensitive, with containment and token
overlap) so "ACME Insurance Co." vs "ACME Insurance Company" is not a false
failure. Dates, numbers, and booleans are matched exactly.
`endorsement_forms` is compared as a normalized set.

**Policy detection** reports precision/recall on the set of coverage types, so
a missed Umbrella line or a phantom policy is visible separately from field
accuracy.

**Confidence routing** is the 2×2 that actually governs the first impression,
because `overall_confidence ≥ 0.6` auto-applies without a human:

- auto-processed **and** accurate → the win
- auto-processed **and** wrong → **trust-killer**; these case IDs are printed
- held for review, and it was wrong → correctly cautious
- held for review, but it was actually fine → overcautious (friction)

The dangerous quadrant is "auto-processed and wrong". A new user who watches a
confidently-applied-but-wrong parse is harder to win back than one who sees an
honest "we flagged this for review". Drive that quadrant to zero before you
optimize anything else.

## Hill-climbing without touching the three synced copies

The prompt and schema exist in **three byte-for-byte copies** that must stay in
sync (`src/workflows/`, `supabase/functions/process-document-jobs/`,
`supabase/functions/retry-failed-documents/`). To trial a change _before_
editing production:

1. Copy `candidate.example.ts` to `candidate.ts` and edit its prompt / effort /
   model.
2. Run the eval — if `candidate.ts` exists, the harness tests it instead of
   production and labels the report accordingly.
3. If it beats the baseline, port the winning change into **all three** copies
   (and bump `EXTRACTION_SCHEMA_VERSION` if the shape or prompt changed), then
   delete `candidate.ts` so the harness is measuring production again.

`candidate.ts` is git-ignored — it is a scratch pad, not a deliverable.
