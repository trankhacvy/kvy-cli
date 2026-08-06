---
"@vibe-oss/kvy": patch
---

Fix a security issue where the CLI sent the real absolute workspace directory path to the server in the clear (via `workspaceId`) instead of an opaque id. Workspace identity is now resolved through a server-unguessable HMAC of the path, and a related caching bug that could permanently drop unmanaged-session upserts after a transient network failure is fixed too.
