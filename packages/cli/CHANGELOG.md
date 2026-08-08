# @vibe-oss/kvy

## 0.1.2

### Patch Changes

- 7d71e5f: Fix the daemon staying "offline" on the dashboard after a laptop sleeps and wakes: the machine client now runs a sleep/wake watchdog that detects the clock gap left by OS suspend and immediately forces a fresh reconnect, instead of waiting out socket.io's own ping-timeout/backoff. `kvy claude`/`kvy codex` also now auto-register the background login service (same as `kvy daemon service install`) the first time a daemon comes up, so a full reboot brings the daemon back too, without the user having to run that command themselves.

## 0.1.1

### Patch Changes

- 6255717: Dedupe the GitHub pull request mapper between githubClient.ts and githubCreatePr.ts so the two no longer risk drifting.
- 7883e9a: Fix biome lint warnings across daemon test files and shared packages.
- c546dc6: Add GitHub Checks tab actions: failure summaries, per-check step detail, re-run/cancel failed or running workflow runs, and a native one-click Create PR.
- 7a3cbd9: Stop exposing `KVY_BACKEND_URL`/`KVY_FRONTEND_URL` to end users: they're now omitted from `kvy --help`'s environment list, and the "could not reach the Kvy server" message no longer tells users to check them. Both env vars still work as overrides (needed for self-hosting and local dev), they're just no longer advertised to users of the hosted service, who never need to set them.
- 299b7f9: Fix a security issue where the CLI sent the real absolute workspace directory path to the server in the clear (via `workspaceId`) instead of an opaque id. Workspace identity is now resolved through a server-unguessable HMAC of the path, and a related caching bug that could permanently drop unmanaged-session upserts after a transient network failure is fixed too.
