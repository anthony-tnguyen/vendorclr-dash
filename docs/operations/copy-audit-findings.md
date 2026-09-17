# Copy audit findings: compliance-guarantee language

Status: Task 12 (data lifecycle - Engineer A slice).

The plan's Task 12 includes "Copy audit removes guarantee language" - user-
facing copy in `src/features/**`/`src/routes/**` should read as
requirements-based ("meets the requirements you've configured") rather than
as VendorClr itself asserting an absolute compliance guarantee ("guaranteed
compliant," "ensures compliance," "certifies," "warrants," and similar).

This is a findings-only document. **No UI copy was edited as part of this
task** - `src/features/**` is Engineer B's file-ownership territory per the
plan's own file-ownership table; this document hands off what was found for
Engineer B (or a future session) to act on.

## Method

Grepped `src/features/**` and `src/routes/**` (case-insensitive) for:

- `guarantee|guaranteed|ensures compliance|certifies|warrant|100% compliant|fully compliant`
- `is compliant|are compliant|fully insured|risk-free|compliance is guaranteed|automatically compliant|always compliant|proves compliance|confirms compliance`
- `legally|liability|protects you|risk-free|certified|attest|assure|confirms your|verif(y|ied) compliance`
- `peace of mind|never worry|always up to date|rest assured|protect your business|eliminate risk|zero risk|no gaps|complete confidence`
- `ensures |certif|verified|compliant\b` (broader sweep, to catch borderline non-exact-phrase hits)

Also reviewed `src/routes/index.tsx` (the one route outside the dashboard
app that could plausibly carry marketing-style copy) directly - it does not
currently contain any compliance-related copy at all (no landing/marketing
page content exists there today).

## Findings

**No guarantee-language violations were found.** Every hit on the broader
sweep was either:

- A status label/enum value (`"compliant"` as a `vendor.status` union
  member and its Tailwind/filter usage in
  `src/features/vendors/VendorsPage.tsx`,
  `src/features/overview/OverviewPage.tsx`, `src/features/reports/
ReportsPage.tsx`) - a state name, not a claim VendorClr is asserting
  about the real world.
- A field label (`"Minimum general liability per occurrence (USD)"` in
  `src/features/settings/SettingsPage.tsx`) - describing an insurance
  coverage type, not a liability claim.
- Already correctly framed as requirements-based, and worth calling out as
  the existing standard to hold new copy to:

  > `src/features/help/HelpPage.tsx:47` - "Compliant: coverage on file
  > meets requirements and hasn't expired. Expiring: still valid, but
  > inside the renewal window. Missing: no policy on file for this
  > requirement. Expired: coverage on file has lapsed. In review: a
  > submitted document is waiting on a compliance queue decision."

  This is exactly the pattern the plan asks for: "compliant" is defined
  in-context as "meets the requirements you've configured," not asserted
  as an absolute, VendorClr-guaranteed fact about the vendor's real-world
  insurance status.

## Recommendation

No copy changes are required today. As new user-facing copy is added
(especially anything summarizing overall account/vendor status, e.g. a
dashboard headline or an email subject line), hold it to the
`HelpPage.tsx` framing above: describe compliance as a match against
configured requirements, never as a standalone claim VendorClr is making
about a vendor's actual insurance status or legal standing. Re-run this
same grep sweep against `src/features/**`/`src/routes/**` before each
future release that touches vendor/compliance-facing copy, since this is a
narrow point-in-time check, not a lint rule enforced in CI.
