# Add VITE_APP_URL via a project .env file

## Problem

Lovable's Secrets UI rejects `VITE_`-prefixed variables — they are build-time
browser values that must live in a `.env` file, not in secrets. There is
currently no `.env` file in the project (only `.env.example`), so
`VITE_APP_URL` is unset and `bareVendorUploadUrl()` in
`src/workflows/vendorUploadRequests.ts` falls back to
`http://localhost:3000` for vendor-upload / magic-link URLs.

## Plan

Create a `.env` file at the project root containing the one variable:

```
VITE_APP_URL=https://dashboard.vendorclr.com
```

This is the only change. `.env` is already gitignored (`.env` and `.env.local`
are listed under "Local env"), so it stays out of source control.

## Effect

- Vite reads `.env` at build time and injects `VITE_APP_URL` into the browser
  bundle via `import.meta.env`.
- `bareVendorUploadUrl()` returns `https://dashboard.vendorclr.com` instead of
  the `http://localhost:3000` fallback.
- Applies to preview and published builds that run in this workspace.

## Limitations

- `.env` is a local/workspace-level file. It works for builds that run here,
  but is not a guaranteed cross-environment setting the way a managed secret
  would be. If the value ever needs to differ per environment, the
  `.env.example` comment is the documentation source of truth.
- No backend is enabled by this change — it only supplies a public base URL
  string to client/server bundle code.
