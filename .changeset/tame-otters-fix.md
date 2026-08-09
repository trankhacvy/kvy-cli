---
"@vibe-oss/kvy": patch
---

Fix flaky CLI tests that only failed under multi-package parallel test contention (widened timeouts/debounce margins, replaced fixed-delay waits with polling). Test-only change, no behavior difference.
