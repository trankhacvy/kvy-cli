---
"@vibe-oss/kvy": patch
---

Fix the daemon staying "offline" on the dashboard after a laptop sleeps and wakes: the machine client now runs a sleep/wake watchdog that detects the clock gap left by OS suspend and immediately forces a fresh reconnect, instead of waiting out socket.io's own ping-timeout/backoff. `kvy claude`/`kvy codex` also now auto-register the background login service (same as `kvy daemon service install`) the first time a daemon comes up, so a full reboot brings the daemon back too, without the user having to run that command themselves.
