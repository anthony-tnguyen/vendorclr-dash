# Subprocessors

Status: Task 12 (data lifecycle - Engineer A slice).

This is a **factual, technical list** of the third-party services this
application's own code actually sends company/vendor data to, produced by
reading the integrations directly (not by guessing). It is not a legal
commitment, a warranty, or a claim that any contractual relationship (a
signed DPA, specific contractual terms) exists with any of these
providers - whether such agreements exist or are needed is a legal
determination outside this document's scope (same constraint as
`docs/operations/data-retention.md`: engineering does not invent legal
commitments). If this list is used as an input to a customer-facing
subprocessor disclosure or a DPA, counsel/product should review it and add
whatever contractual language is appropriate - none is added here.

## How this was compiled

Each entry below was verified against the actual code that calls the named
service, not assumed from the provider's general reputation:

| Provider       | Where it's actually called                                                                                                                                                                                                                                                                         | What data reaches it                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supabase**   | `src/lib/supabase/serverClient.server.ts`, `src/lib/supabase/client.ts` - every database read/write, every `vendor-documents` storage object, and Supabase Auth for login.                                                                                                                         | All of it. Supabase hosts the Postgres database (every table in `src/data/db-types.ts`), the private `vendor-documents` storage bucket (uploaded certificates), and user authentication. This is the primary data store, not an incidental integration.                                                                                                                                                                                                          |
| **Anthropic**  | `src/workflows/documentExtraction.ts` (`@anthropic-ai/sdk`, `createAnthropicExtractor()`), called when `ANTHROPIC_API_KEY` is set.                                                                                                                                                                 | The bytes of an uploaded certificate-of-insurance document (PDF/JPEG/PNG, base64-encoded - see `buildDocumentContentBlocks()`), sent to the Anthropic Messages API for structured-data extraction (policy numbers, coverage limits, dates, certificate holder). Without this key configured, no document is ever sent - extraction is skipped and the document stays in `'failed'`/unprocessed status (see `supabase/README.md`).                                |
| **Resend**     | `src/workflows/emailSender.ts` (`createResendSender()`), called when `RESEND_API_KEY` is set.                                                                                                                                                                                                      | Vendor and company-member email addresses (the `to` field), plus the email body/subject for renewal-request, document-received, and admin-review-needed notifications. Also receives (via the `resend-webhook` Edge Function, `supabase/functions/resend-webhook/`) bounce/delivery status callbacks. Without the API key configured, no email is sent for real - the magic link is returned directly to the admin instead.                                      |
| **VirusTotal** | `src/workflows/malwareScanner.ts` (`createVirusTotalScanner()`), called when `VIRUSTOTAL_API_KEY` is set.                                                                                                                                                                                          | The SHA-256 hash of an uploaded document (a hash lookup against VirusTotal's `GET /files/{sha256}`, not a file upload - see the file's own docblock for why this is deliberately hash-only). Without the key configured, uploads still succeed with `malware_scan_status` recorded as `'not_configured'`.                                                                                                                                                        |
| **Cloudflare** | Deployment target (`vite.config.ts`'s Nitro `cloudflare-module` preset; see `docs/operations/release-process.md`), and optionally Cloudflare Turnstile (`src/workflows/uploadAbuse.server.ts`, `TURNSTILE_SECRET_KEY`, currently documented but not wired to a live account - see `.env.example`). | As hosting: every request to the deployed app passes through Cloudflare's Workers runtime, which sees the same request/response data any hosting provider would (headers, body, IP address for `assertUploadAllowed()`'s HMAC'd rate limiting). As Turnstile (when configured): a CAPTCHA verification token, POSTed server-side to Cloudflare's siteverify endpoint - no document or company data.                                                              |
| **Sentry**     | `src/lib/observability/sentry.server.ts`, `sentryClient.ts` - error capture, active only when `VITE_SENTRY_DSN` is set.                                                                                                                                                                            | Error events (exception messages, stack traces) from both server and client. `redact()` in `src/lib/observability/logger.server.ts` is applied to the _structured operational log_, not directly to Sentry's own envelope builder (`sentryEnvelope.ts`) - review `buildErrorEvent()`/`buildEnvelope()` directly if a precise claim about what an error message might contain is ever needed for a DPA. Without a DSN configured, Sentry capture no-ops entirely. |

## What is deliberately NOT on this list

- Providers referenced only in documentation or `.env.example` comments
  with no actual call site found in `src/**`/`supabase/functions/**` (none
  identified as of this writing - every optional integration in
  `.env.example` was traced to a real call site above).
- Any provider this document's author has not personally verified against
  the code. If a new integration is added, this list needs a corresponding
  update, verified the same way (find the actual call site, name exactly
  what data reaches it) - not extended by assumption.
