import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // Points Vite's env loader somewhere with no .env files, so a developer's
  // local .env (real Supabase credentials, once Phase 0/1 are wired up) never
  // leaks into import.meta.env here. Demo mode - hasBackendEnv() === false -
  // must hold regardless of what's in the working tree's .env; that's the
  // guarantee the whole app suite is written against (see
  // src/lib/supabase/env.ts). Does not affect `bun run dev`/`build`, which
  // use the root vite config, not this file.
  envDir: "./.vitest-env-isolation",
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/tests/**/*.test.{ts,tsx}"],
  },
});
