-- Stage 1 (Settings) - actor trail for insurance-requirement changes.
--
-- NOT YET APPLIED. This project points at an external Supabase project, and
-- supabase/migrations/ is managed outside this workspace, so this file lives
-- here until it is moved into supabase/migrations/ and shipped through the
-- normal migration flow.
--
-- Why a trigger: requirement_profiles / requirement_profile_rules are written
-- directly by the request-scoped client (RLS gates writes to owner and
-- risk_manager via has_company_role()), so unlike the invitation and
-- compliance-case paths there is no SECURITY DEFINER RPC in the middle that
-- could record the change. A trigger is the only place that sees every write,
-- including writes made outside the Settings UI.
--
-- One audit_log row per changed rule, not per save: raising the GL
-- each-occurrence minimum and dropping the pollution requirement are two
-- separate facts, and collapsing them makes the history unreadable.
--
-- Until this is applied, the Settings page's "Change history" panel renders
-- its empty state; nothing else on the page depends on it.

alter table public.audit_log
  drop constraint audit_log_action_check;

alter table public.audit_log
  add constraint audit_log_action_check
  check (action in (
    'upload_request_created', 'upload_request_cancelled', 'review_resolved', 'document_reprocessed',
    'member_invited', 'member_invite_resent', 'member_invite_revoked', 'invite_accepted',
    'member_role_changed', 'member_removed', 'contact_request_sent',
    'submission_package_finalized', 'submission_document_replaced',
    'extraction_reviewer_edit', 'compliance_exception_approved', 'compliance_exception_expired',
    'vendor_import_executed', 'report_exported',
    'requirement_rule_added', 'requirement_rule_changed', 'requirement_rule_removed'
  ));

alter table public.audit_log
  drop constraint audit_log_target_type_check;

alter table public.audit_log
  add constraint audit_log_target_type_check
  check (target_type in (
    'vendor', 'vendor_upload_request', 'vendor_document', 'compliance_queue_item',
    'company_member', 'company_invitation', 'compliance_deficiency', 'vendor_import_batch',
    'company', 'audit_snapshot', 'requirement_profile'
  ));

-- SECURITY DEFINER because audit_log has no INSERT policy for authenticated -
-- every other writer reaches it from inside a definer boundary too.
create or replace function public.record_requirement_rule_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row    public.requirement_profile_rules;
  v_action text;
begin
  if tg_op = 'DELETE' then
    v_row := old;
    v_action := 'requirement_rule_removed';
  elsif tg_op = 'INSERT' then
    v_row := new;
    v_action := 'requirement_rule_added';
  else
    v_row := new;
    v_action := 'requirement_rule_changed';
    -- Nothing a human decided changed; do not manufacture history for an
    -- updated_at touch.
    if old.required is not distinct from new.required
      and old.amount is not distinct from new.amount
      and old.policy_type is not distinct from new.policy_type
      and old.rule_kind is not distinct from new.rule_kind
      and old.configuration is not distinct from new.configuration then
      return null;
    end if;
  end if;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (
    v_row.company_id,
    auth.uid(),
    v_action,
    'requirement_profile',
    v_row.profile_id,
    jsonb_build_object(
      'rule_key', v_row.rule_key,
      'policy_type', v_row.policy_type,
      'rule_kind', v_row.rule_kind,
      'required', v_row.required,
      'amount', v_row.amount,
      'previous_amount', case when tg_op = 'UPDATE' then old.amount else null end,
      'previous_required', case when tg_op = 'UPDATE' then old.required else null end
    )
  );

  return null;
end;
$fn$;

revoke execute on function public.record_requirement_rule_audit() from public, anon;

create trigger requirement_profile_rules_audit
after insert or update or delete on public.requirement_profile_rules
for each row execute function public.record_requirement_rule_audit();
