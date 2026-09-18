-- get_advisors flagged audit_log_actor_id_fkey as unindexed, same as every
-- other FK on this table already had its own index for.
--
-- IF NOT EXISTS: 20260902000900_audit_log.sql was edited after this fix was
-- applied live to include this same index directly, so replaying both
-- against a fresh database (as PGlite/db:verify does) would otherwise
-- collide on an object this migration already created historically.
create index if not exists audit_log_actor_idx on public.audit_log (actor_id);
