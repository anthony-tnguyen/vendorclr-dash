-- Staff "Request changes": send a submitted workspace back to the customer.
--
-- Before this, a staff reviewer could only launch or wait silently. request_
-- company_changes() moves a company from 'in_review' back to 'onboarding' and
-- clears submitted_at, so the customer drops out of the under-review state and
-- back into the editable wizard to fix what's missing, then resubmit.
--
-- Re-runnable. Applied to staging (ukbgjriqszthtgwxyirr) first; NOT applied to
-- production by this migration.

-- Widen the audit vocabulary for the new action (full existing list preserved).
alter table public.audit_log drop constraint if exists audit_log_action_check;
alter table public.audit_log
  add constraint audit_log_action_check
  check (action = any (array[
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
    'requirement_profile_created', 'requirement_profile_updated', 'requirement_profile_archived',
    'requirement_profile_defaulted',
    'contact_created', 'contact_updated', 'vendor_contact_linked',
    'vendor_contact_role_changed', 'vendor_contact_unlinked',
    'recipient_suppressed', 'recipient_unsuppressed',
    'checkout_completed', 'subscription_updated', 'onboarding_submitted', 'service_activated',
    -- appended by this migration:
    'onboarding_changes_requested'
  ]));

create or replace function public.request_company_changes(target_company uuid)
returns public.companies
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  admin_id uuid := (select auth.uid());
  result   public.companies;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Only a company that is actually awaiting review can be sent back.
  update public.companies
  set service_status = 'onboarding'
  where id = target_company and service_status = 'in_review'
  returning * into result;

  if result.id is null then
    raise exception 'Only a company awaiting review can be sent back for changes.'
      using errcode = '22023';
  end if;

  -- Clearing submitted_at drops the customer out of the under-review state and
  -- back into the editable wizard at the review step.
  update public.company_onboarding
  set submitted_at = null,
      current_step = greatest(least(current_step, 6), 1)
  where company_id = target_company;

  insert into public.audit_log (company_id, actor_id, action, target_type, target_id, detail)
  values (target_company, admin_id, 'onboarding_changes_requested', 'company', target_company,
          jsonb_build_object('service_status', 'onboarding'));

  return result;
end;
$fn$;

revoke execute on function public.request_company_changes(uuid) from public, anon;
grant execute on function public.request_company_changes(uuid) to authenticated;
