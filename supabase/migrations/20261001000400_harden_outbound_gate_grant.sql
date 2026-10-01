-- Harden the managed-service outbound gate's trigger function.
--
-- 20261001000200 created enforce_service_live_for_requests() as a SECURITY
-- DEFINER function but left the default EXECUTE grant in place, so it was
-- reachable as a PostgREST RPC (/rest/v1/rpc/enforce_service_live_for_requests)
-- by anon and authenticated — flagged by the database linter
-- (0028/0029 anon|authenticated_security_definer_function_executable).
--
-- It is a trigger helper, never meant to be called directly. Triggers fire with
-- the table owner's privileges regardless of role EXECUTE grants, so revoking
-- EXECUTE does not affect the BEFORE INSERT trigger on vendor_upload_requests —
-- it only removes the unintended RPC surface. Idempotent and safe to re-run.

revoke execute on function public.enforce_service_live_for_requests()
  from public, anon, authenticated;
