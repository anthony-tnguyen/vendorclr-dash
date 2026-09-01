/**
 * Backend feature flag.
 *
 * The whole app degrades to the in-memory demo when Supabase is not configured:
 * `getRepository()` returns the demo repository, the auth screens keep their
 * "does not authenticate anyone" disclaimer, and the demo role switcher stays
 * visible. That is what lets the Vitest suite and the Lovable preview run with no
 * database and no secrets.
 *
 * Both variables must be VITE_-prefixed to reach the browser bundle. The anon key
 * is public by design; it is only ever as powerful as the RLS policies allow, which
 * is why every table in supabase/migrations enables RLS with no permissive default.
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

function read(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv];
  return typeof value === "string" ? value.trim() : "";
}

export function readSupabaseEnv(): SupabaseEnv | null {
  const url = read("VITE_SUPABASE_URL");
  const anonKey = read("VITE_SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** True when the app should talk to a real backend instead of the demo repository. */
export function hasBackendEnv(): boolean {
  return readSupabaseEnv() !== null;
}
