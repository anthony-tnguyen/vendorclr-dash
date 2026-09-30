# Keep demo mode off in the preview for good

## Why it keeps coming back

The preview only connects to the real backend when it can find two connection
settings. Those were in a file named `.env`, but `.env` is on the project's
"don't save" list, so it is never stored with the project. Whenever the
workspace starts fresh, the file is gone and the app falls back to demo mode.
`.env.staging` and `.env.production` are saved, but the preview doesn't read
either one on its own.

## Fix

1. Add a saved file named `.env.development` that holds the same staging
   values as `.env.staging` (the staging backend address, its public key, and
   the app address). The preview reads this file automatically, so it stays
   connected to staging (Stripe test mode) even after a fresh start.
   Published builds keep using `.env.production`, so the live site doesn't change.
2. Restart the preview. Then check that /login shows the real sign-in form and
   /checkout has no demo banner.
3. Update the project note about demo mode so it says `.env.development` is now
   the fix, instead of copying files by hand.

## Technical details

- Vite loads `.env.development` in dev mode and `.env.production` for builds.
  `.gitignore` only lists `.env` and `.env.local`, so the new file gets saved.
- The only values in it are the public publishable key and URLs, which are
  already saved in `.env.staging`. No secrets go in it.
- Tests stub env vars on their own (vitest mode), so the demo-mode tests don't change.
