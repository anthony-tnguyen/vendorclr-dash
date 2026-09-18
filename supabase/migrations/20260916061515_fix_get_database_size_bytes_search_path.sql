create or replace function public.get_database_size_bytes()
returns bigint
language sql
stable
set search_path = pg_catalog, pg_temp
as $fn$
  select pg_database_size(current_database());
$fn$;

revoke execute on function public.get_database_size_bytes() from public, anon, authenticated;
grant execute on function public.get_database_size_bytes() to service_role;
