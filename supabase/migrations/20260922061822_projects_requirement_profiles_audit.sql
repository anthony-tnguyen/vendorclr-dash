-- Auditable lifecycle events for the customer project/assignment/profile UI.
-- The table mutations remain RLS-authorized; these triggers only record an
-- immutable fact after the permitted mutation succeeds.

alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log add constraint audit_log_action_check check (action in (
  'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed',
  'member_invited', 'member_invite_resent', 'member_invite_revoked', 'invite_accepted',
  'member_role_changed', 'member_removed', 'contact_request_sent',
  'submission_package_finalized', 'submission_document_replaced',
  'extraction_reviewer_edit', 'compliance_exception_approved', 'compliance_exception_expired',
  'vendor_import_executed', 'report_exported',
  'requirement_rule_added', 'requirement_rule_changed', 'requirement_rule_removed',
  'activation_code_redeemed', 'company_activated', 'company_access_revoked',
  'project_created', 'project_updated', 'project_closed',
  'assignment_created', 'assignment_updated', 'assignment_terminated',
  'requirement_profile_created', 'requirement_profile_updated',
  'requirement_profile_archived', 'requirement_profile_defaulted'
));

alter table public.audit_log drop constraint if exists audit_log_target_type_check;
alter table public.audit_log add constraint audit_log_target_type_check check (target_type in (
  'vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item',
  'company_member', 'company_invitation', 'compliance_deficiency', 'vendor_import_batch',
  'company', 'audit_snapshot', 'requirement_profile', 'activation_code',
  'project', 'project_vendor_assignment'
));

create or replace function public.record_project_workflow_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row record;
  v_action text;
  v_target_type text;
begin
  v_row := new;
  if tg_table_name = 'projects' then
    v_target_type := 'project';
    if tg_op = 'INSERT' then v_action := 'project_created';
    elsif old.status is distinct from new.status and new.status = 'closed' then v_action := 'project_closed';
    else v_action := 'project_updated'; end if;
  elsif tg_table_name = 'project_vendor_assignments' then
    v_target_type := 'project_vendor_assignment';
    if tg_op = 'INSERT' then v_action := 'assignment_created';
    elsif old.status is distinct from new.status and new.status = 'terminated' then v_action := 'assignment_terminated';
    else v_action := 'assignment_updated'; end if;
  else
    v_target_type := 'requirement_profile';
    if tg_op = 'INSERT' then v_action := 'requirement_profile_created';
    elsif old.archived_at is distinct from new.archived_at and new.archived_at is not null then v_action := 'requirement_profile_archived';
    elsif old.is_company_default is distinct from new.is_company_default and new.is_company_default then v_action := 'requirement_profile_defaulted';
    else v_action := 'requirement_profile_updated'; end if;
  end if;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (v_row.company_id, auth.uid(), v_action, v_target_type, v_row.id,
    jsonb_build_object('before', case when tg_op = 'INSERT' then null else to_jsonb(old) end, 'after', to_jsonb(new)));
  return null;
end;
$fn$;

revoke execute on function public.record_project_workflow_audit() from public, anon;

create trigger projects_workflow_audit after insert or update on public.projects
for each row execute function public.record_project_workflow_audit();
create trigger assignments_workflow_audit after insert or update on public.project_vendor_assignments
for each row execute function public.record_project_workflow_audit();
create trigger requirement_profiles_workflow_audit after insert or update on public.requirement_profiles
for each row execute function public.record_project_workflow_audit();

-- A default swap must update the old and new profile in one statement: the
-- existing deferrable exclusion constraint and statement-level invariant were
-- explicitly designed for this transition. A browser cannot safely compose
-- that operation from two separate PostgREST mutations.
create or replace function public.set_company_default_requirement_profile(profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  profile_company_id uuid;
begin
  select company_id into profile_company_id
  from public.requirement_profiles
  where id = profile_id and archived_at is null;

  if profile_company_id is null
    or not public.has_company_role(profile_company_id, array['owner', 'risk_manager']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update public.requirement_profiles
  set is_company_default = (id = profile_id)
  where company_id = profile_company_id
    and is_company_default is distinct from (id = profile_id);
end;
$fn$;

revoke execute on function public.set_company_default_requirement_profile(uuid) from public, anon;
grant execute on function public.set_company_default_requirement_profile(uuid) to authenticated;
