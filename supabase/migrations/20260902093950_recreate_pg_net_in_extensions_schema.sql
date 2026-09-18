-- ALTER EXTENSION ... SET SCHEMA is not supported for pg_net (confirmed by
-- trying it - Postgres rejects it directly), so the fix is drop + recreate
-- with the schema specified at creation, matching pgcrypto/uuid-ossp's
-- existing placement in this project rather than the public-schema default
-- get_advisors flagged. pg_net's actual functions already live in their own
-- `net` schema regardless (net.http_post, as used by
-- 20260902000600_schedule_renewal_reminders.sql's cron job) - only the
-- extension's own catalog registration was in public.
drop extension pg_net;
create extension pg_net with schema extensions;
