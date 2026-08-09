---
"@vibe-oss/kvy": patch
---

Fix `kvy update` always failing with "could not check for updates": the self-update repo default was a stale placeholder (`kvy-dev/kvy`, a nonexistent repo) instead of the real `trankhacvy/kvy-cli`, so every version check 404'd.
