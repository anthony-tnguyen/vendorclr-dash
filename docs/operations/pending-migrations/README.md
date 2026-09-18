# Pending migrations

Files here are real migrations that have not been committed to
`supabase/migrations/` yet, because this project runs against a Supabase
project that Lovable does not manage: the migration tooling refuses to write
into `supabase/migrations/` for it, so the SQL is authored and reviewed here.

## How one lands

1. Read the file. It says what it changes, what it refuses to do, and how to
   check the result.
2. Apply it to the hosted project (Supabase dashboard → SQL editor, or
   `psql`). Apply the whole file in one go - the functions, grants and
   policies in these files depend on each other.
3. Run the verification queries at the bottom of the file. They are written to
   be read by a person, and each one names the answer it expects.
4. Move the file into `supabase/migrations/` and delete it from here. The
   database tests already exercise it: `supabase/tests/activation-codes.test.ts`
   applies the pending copy on top of the checked-in schema, and its header
   says which two lines to delete once the file has moved - every assertion in
   it is about the model, not the location.
5. `bun run db:verify` and `bun run test`.

## Why not just edit the database

Because the schema is the only copy of the rules that decide who may see what.
A change applied by hand and never written down is a rule nobody can review,
and the next person to restore a backup will quietly undo it.
