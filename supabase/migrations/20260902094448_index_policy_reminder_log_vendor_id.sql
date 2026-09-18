-- get_advisors flagged policy_reminder_log_vendor_id_fkey as unindexed, same
-- as every other FK on this table already had its own index for.
--
-- IF NOT EXISTS: 20260902000500_renewal_reminders.sql was edited after this
-- fix was applied live to include this same index directly, so replaying
-- both against a fresh database (as PGlite/db:verify does) would otherwise
-- collide on an object this migration already created historically.
create index if not exists policy_reminder_log_vendor_idx on public.policy_reminder_log (vendor_id);
