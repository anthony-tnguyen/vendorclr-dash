import { defineConfig } from "vitest/config";

/**
 * Database verification suite (`bun run db:verify`).
 *
 * Kept separate from vitest.config.ts because these tests need a node
 * environment (PGlite, not jsdom) and each file boots its own Postgres, which is
 * far slower than the component suite. `bun run test` stays fast; CI runs both.
 *
 * Files run sequentially: several Postgres instances at once is memory-hungry for
 * no benefit, since each suite is already isolated by having its own database.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["supabase/tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
