---
"@vibe-oss/kvy": patch
---

Stop exposing `KVY_BACKEND_URL`/`KVY_FRONTEND_URL` to end users: they're now omitted from `kvy --help`'s environment list, and the "could not reach the Kvy server" message no longer tells users to check them. Both env vars still work as overrides (needed for self-hosting and local dev), they're just no longer advertised to users of the hosted service, who never need to set them.
