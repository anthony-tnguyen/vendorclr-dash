# example-clean-acord25 (template — not runnable as shipped)

This directory is a **worked template** showing the exact shape of an
`expected.json`. It has no `document.*`, so the harness skips it with a notice
rather than running it. The field values are illustrative/synthetic.

To turn it into a real case (or model a new one on it):

1. Drop the certificate in as `document.pdf` (or `.png` / `.jpg` / `.jpeg`).
   Use a redacted, synthetic, or cleared certificate — see the top-level
   `evals/coi-extraction/README.md` note on not committing customer data.
2. Edit `expected.json` so every field is the **hand-verified** correct reading
   of that certificate. Unreadable/absent fields must be `null`.
3. Run `bun run eval:coi -- --limit=1 --cases=evals/coi-extraction/cases` after
   temporarily isolating this case, or just run the whole set.

What makes a good case is not a clean form — it is a certificate that exercises
something the parser gets wrong today: a struck-through cancellation clause, a
split CG 20 10 / CG 20 37 additional-insured, a WC Part Two limits block, a
poor scan, or a multi-policy form.
