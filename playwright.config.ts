import { defineConfig, devices } from "@playwright/test";

/**
 * Minimal Playwright config for the `e2e-smoke` CI job (Task 0A).
 *
 * This intentionally targets the *production bundle*, not the Vite dev
 * server: `webServer.command` boots the built Cloudflare Worker output
 * (`.output/server`, produced by `bun run build`) under `wrangler dev`,
 * the same runtime nitro's `cloudflare-module` preset deploys to
 * production. A dev-server smoke test would not catch a build- or
 * runtime-only regression (e.g. a Workers-incompatible API slipping into
 * a server function).
 *
 * Run locally with:
 *   bun run build
 *   bunx playwright test e2e/smoke.spec.ts
 *
 * Set PLAYWRIGHT_BASE_URL to point at an already-running server (e.g. a
 * deployed staging environment, from staging-smoke.yml) instead of having
 * Playwright manage `wrangler dev` itself.
 *
 * Task 0B (Engineer B) owns full role-based coverage under e2e/**; this
 * config only needs to support the minimal smoke spec until that lands.
 */
const isCI = process.env["CI"] === "true";
const externalBaseURL = process.env["PLAYWRIGHT_BASE_URL"];

const config: Parameters<typeof defineConfig>[0] = {
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: externalBaseURL ?? "http://localhost:8788",
    trace: "on-first-retry",
    // Environments whose system libraries do not satisfy Playwright's bundled
    // Chromium can point at a working one, e.g. PLAYWRIGHT_CHROMIUM_EXECUTABLE
    // from a nix-built chromium. CI uses the bundled browser.
    ...(process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"]
      ? { launchOptions: { executablePath: process.env["PLAYWRIGHT_CHROMIUM_EXECUTABLE"] } }
      : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
};

if (!externalBaseURL) {
  config.webServer = {
    // The build moved to dist/ (nitro cloudflare-module preset); the
    // deploy config under .wrangler/deploy points at dist/server/wrangler.json.
    command: "bunx wrangler dev --config dist/server/wrangler.json --port 8788",
    url: "http://localhost:8788",
    reuseExistingServer: !isCI,
    timeout: 60_000,
  };
}

export default defineConfig(config);
