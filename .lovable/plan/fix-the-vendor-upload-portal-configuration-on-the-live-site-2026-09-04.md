# Fix the vendor upload portal configuration on the live site

## Confirmed diagnosis

- `VENDORCLEAR_SERVICE_ROLE_KEY` exists in the encrypted project secret store.
- The currently running local Vite server receives that variable.
- The live custom domain still reproduces the exact configuration error on `/vendor-upload/<token>`.
- The service-role client currently gets its database URL indirectly from `VITE_SUPABASE_URL` through a browser-oriented helper. This couples server execution to a build-time client variable and makes the combined error unable to identify which value is absent.
- The live deployment therefore needs an explicit server-runtime database URL and a fresh deployment containing the corrected lookup.
- A linked App Connection is not required for this environment-variable-based integration.

## Plan

1. Add `VENDORCLEAR_SUPABASE_URL` as a server runtime setting using the existing project URL (`https://fzrcowwonezflydicpbd.supabase.co`). Keep `VENDORCLEAR_SERVICE_ROLE_KEY` encrypted and server-only.
2. Update the service-role client to read both values directly from `process.env` inside the server-only call path. Do not expose the service-role key through any `VITE_` variable.
3. Split the configuration validation so future errors identify the specific missing setting instead of reporting both together.
4. Verify locally that an invalid test token now reaches normal token validation (invalid/expired link) rather than the environment-configuration error.
5. Run the focused tests and production build, then publish a fresh deployment so the custom domain receives the runtime settings.
6. Re-test the custom-domain upload route and confirm the configuration error is gone. Existing links should work without being regenerated because their tokens and database rows are unchanged.

## Scope

- No migrations or schema changes.
- No new database or Lovable Cloud project.
- No App Connection is required; the app remains pointed at the existing project through explicit environment configuration.
