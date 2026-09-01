-- Local development seed. Runs on `supabase db reset`.
--
-- Mirrors a subset of src/data/demoRepository.ts so the live path can be compared
-- against the demo path screen by screen.
--
-- Attaches everything to the FIRST user in auth.users, so the intended order is:
--   1. supabase start
--   2. sign up through the app (or Studio) to create a user
--   3. supabase db reset   <- this file then wires that user to the seeded company
--
-- No-ops when auth.users is empty, so a fresh reset before signup is harmless.

do $seed$
declare
  target_user  uuid;
  target_email text;
  demo_company uuid;
  v_corbett    uuid;
  v_rivera     uuid;
  v_delgado    uuid;
begin
  select id, email into target_user, target_email
  from auth.users
  order by created_at
  limit 1;

  if target_user is null then
    raise notice 'seed skipped: no auth.users row yet. Sign up first, then re-run.';
    return;
  end if;

  -- Idempotent: drop any previous seeded company so repeated runs do not stack up.
  delete from public.companies where name = 'Halstead Builders';

  insert into public.companies (name, plan, subscription_renews_on)
  values ('Halstead Builders', 'Program', '2027-03-01')
  returning id into demo_company;

  insert into public.company_members (company_id, user_id, role, scope, last_active_at)
  values (demo_company, target_user, 'owner', 'All projects', now())
  on conflict (company_id, user_id) do update set role = 'owner';

  -- Vendors ----------------------------------------------------------------
  insert into public.vendors
    (company_id, name, trade, project, contract_value, contact_name, contact_email, risk_tier)
  values
    (demo_company, 'Corbett Structural Steel', 'Structural Steel', 'Harbor Point Tower B',
     4820000, 'Dana Corbett', 'dana@corbettsteel.example', 'high')
  returning id into v_corbett;

  insert into public.vendors
    (company_id, name, trade, project, contract_value, contact_name, contact_email, risk_tier)
  values
    (demo_company, 'Rivera Electrical Contractors', 'Electrical', 'Harbor Point Tower B',
     2140000, 'Manny Rivera', 'manny@riveraelectric.example', 'moderate')
  returning id into v_rivera;

  insert into public.vendors
    (company_id, name, trade, project, contract_value, contact_name, contact_email, risk_tier)
  values
    (demo_company, 'Delgado Concrete Works', 'Concrete', 'Cedar Ridge Medical',
     1960000, 'Sofia Delgado', 'sofia@delgadoconcrete.example', 'high')
  returning id into v_delgado;

  -- Policies. Note Corbett carries three separate coverages with different
  -- carriers and dates - the case the single policy_number column could not hold.
  insert into public.vendor_policies
    (company_id, vendor_id, policy_type, carrier_name, policy_number,
     effective_date, expiration_date, each_occurrence_limit, general_aggregate_limit,
     additional_insured, waiver_of_subrogation, status, verification_status)
  values
    (demo_company, v_corbett, 'general_liability', 'Travelers', 'GL-8841-2266',
     '2025-11-30', '2026-11-30', 2000000, 4000000, true, true, 'active', 'verified'),
    (demo_company, v_corbett, 'umbrella', 'Travelers', 'XS-8841-0091',
     '2025-11-30', '2026-11-30', 15000000, null, true, true, 'active', 'verified'),
    (demo_company, v_corbett, 'workers_compensation', 'Hartford', 'WC-2214-8890',
     '2025-11-30', '2026-11-30', 1000000, null, false, true, 'active', 'verified'),

    (demo_company, v_rivera, 'general_liability', 'Cincinnati', 'GL-2210-7741',
     '2025-09-14', '2026-09-14', 2000000, 4000000, true, false, 'active', 'needs_review'),
    (demo_company, v_rivera, 'commercial_auto', 'Cincinnati', 'AU-2210-3310',
     '2025-09-14', '2026-09-14', 500000, null, true, false, 'active', 'needs_review'),

    -- Lapsed on purpose: exercises the expired path end to end.
    (demo_company, v_delgado, 'general_liability', 'Nationwide', 'GL-3320-9014',
     '2025-07-31', '2026-07-31', 1000000, 2000000, false, false, 'expired', 'unverified');

  -- Compliance rail. The vendors_seed_compliance_items trigger already created all
  -- five rows per vendor as 'missing'; update only what is actually evidenced.
  update public.vendor_compliance_items set status = 'compliant', effective_date = '2026-11-30'
    where vendor_id = v_corbett
      and requirement_key in ('coi', 'additionalInsured', 'waiverOfSubrogation', 'renewal');
  update public.vendor_compliance_items
    set status = 'pending', effective_date = '2026-08-25',
        note = 'Conditional progress waiver in review'
    where vendor_id = v_corbett and requirement_key = 'lienWaiver';

  update public.vendor_compliance_items
    set status = 'expiring', effective_date = '2026-09-14', note = '17 days to expiration'
    where vendor_id = v_rivera and requirement_key in ('coi', 'renewal');
  update public.vendor_compliance_items set status = 'compliant', effective_date = '2026-09-14'
    where vendor_id = v_rivera and requirement_key = 'additionalInsured';
  update public.vendor_compliance_items
    set status = 'missing', note = 'Endorsement not attached to COI'
    where vendor_id = v_rivera and requirement_key = 'waiverOfSubrogation';
  update public.vendor_compliance_items set status = 'compliant', effective_date = '2026-08-01'
    where vendor_id = v_rivera and requirement_key = 'lienWaiver';

  update public.vendor_compliance_items
    set status = 'expired', effective_date = '2026-07-31', note = 'Certificate lapsed'
    where vendor_id = v_delgado
      and requirement_key in ('coi', 'additionalInsured', 'renewal');

  -- Coverage limits ---------------------------------------------------------
  insert into public.vendor_coverage_limits
    (company_id, vendor_id, label, required_amount, carried_amount, sort_order)
  values
    (demo_company, v_corbett, 'General liability / occurrence', 2000000, 2000000, 0),
    (demo_company, v_corbett, 'Excess liability', 10000000, 15000000, 1),
    (demo_company, v_corbett, 'Workers compensation', 1000000, 1000000, 2),
    (demo_company, v_rivera, 'General liability / occurrence', 2000000, 2000000, 0),
    (demo_company, v_rivera, 'Auto liability', 1000000, 500000, 1),
    (demo_company, v_delgado, 'General liability / occurrence', 2000000, 1000000, 0),
    (demo_company, v_delgado, 'Excess liability', 5000000, 0, 1);

  -- Tasks and review queue ---------------------------------------------------
  insert into public.tasks (company_id, vendor_id, title, due_on, priority, status, owner)
  values
    (demo_company, v_rivera, 'Request waiver of subrogation endorsement',
     current_date + 3, 'high', 'open', 'Rosa Sandoval'),
    (demo_company, v_delgado, 'Chase lapsed certificate',
     current_date - 2, 'high', 'open', 'Rosa Sandoval'),
    (demo_company, null, 'Confirm renewal requirements for Q4 bid package',
     current_date + 14, 'low', 'waiting', 'Kenji Lieu');

  insert into public.compliance_queue_items
    (company_id, vendor_id, document_label, submitted_on, state)
  values (demo_company, v_corbett, 'Conditional lien waiver', current_date - 5, 'queued');

  raise notice 'seeded company % for user %', demo_company, coalesce(target_email, target_user::text);
end;
$seed$;

-- Platform pipeline data is staff-only and independent of any company.
insert into public.leads (company_name, contact_name, trade, source, stage, created_on)
values
  ('Kestrel Design Build', 'Nina Park', 'General contractor', 'Referral', 'qualified', current_date - 6),
  ('Bay Line Utilities', 'Omar Haddad', 'Underground utilities', 'Trade show', 'new', current_date - 8),
  ('Fielder & Sons Paving', 'Jo Fielder', 'Paving', 'Website', 'demo', current_date - 14)
on conflict do nothing;
