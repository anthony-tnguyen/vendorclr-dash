# Fix "VENDORCLEAR_SERVICE_ROLE_KEY must be set" on the vendor upload link

## Diagnosis (confirmed by reads)

- The server function that resolves upload tokens (`src/lib/supabase/serverClient.server.ts`) reads `process.env["VENDORCLEAR_SERVICE_ROLE_KEY"]` at request time.
- The secret **is** saved in the Lovable secret store (confirmed via the secrets listing).
- The error still appears because the running dev server process predates the secret being added — `process.env` for the server runtime is populated when the server starts, so it never saw the new value.

## Plan

1. **Restart the dev server** so the server runtime re-reads its environment, picking up `VENDORCLEAR_SERVICE_ROLE_KEY` from the secret store.
2. **Verify the upload portal works end to end**: create a test upload request from the vendor detail page, open the generated `/vendor-upload/<token>` link, and confirm the "This link isn't working / must both be set" error is gone and the portal loads the vendor name.
3. **Fallback if the error persists after restart**: the preview sandbox may not inject runtime secrets into the dev server process. In that case, add `VENDORCLEAR_SERVICE_ROLE_KEY` to the gitignored local `.env` (server-only, no `VITE_` prefix, so it never ships to the browser). This requires the service-role key value — since stored secrets can't be read back, you would re-enter it via the secure form (update_secret) or paste it once for the local file.

## Your question about Connections showing "no connection"

No connection is required. Your app talks to your existing Supabase project through environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VENDORCLEAR_SERVICE_ROLE_KEY`), which is a valid setup. The Connectors section would only show something if you linked a managed/external Supabase connection under Project Settings → Connectors — doing so is optional and would just re-supply the same credentials. Nothing about the current error is caused by the missing connection.

## Notes

- No database changes, no migrations, no new backend enabled.
- Only `.env` would be modified (and only if the restart alone doesn't fix it).
