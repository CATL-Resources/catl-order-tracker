# Edge Functions

Edge functions (background jobs) in this directory deploy to PRODUCTION through GitHub Actions when a change under `supabase/functions/` merges to `main` (`.github/workflows/deploy-edge-functions.yml`).

1. Edit the function in `supabase/functions/<name>/index.ts` on a branch.
2. Open a pull request. Merge only when every check is green.
3. Never leave a fix live-only. The source in this folder is the source of truth.

A function that must require a signed-in caller has an empty `verify_jwt` file in its folder. Every other function deploys without that check.
