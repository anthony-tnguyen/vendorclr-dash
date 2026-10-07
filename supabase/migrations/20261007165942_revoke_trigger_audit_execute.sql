-- These functions are installed as trigger procedures and are never an RPC
-- surface. Supabase grants EXECUTE directly to named API roles through its
-- default privileges, so revoking only PUBLIC does not remove authenticated
-- access. Trigger execution does not require the caller to retain EXECUTE.
revoke execute on function public.record_project_workflow_audit()
  from public, anon, authenticated;

revoke execute on function public.record_requirement_rule_audit()
  from public, anon, authenticated;
