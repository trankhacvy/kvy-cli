#!/bin/sh
# Server container entrypoint (design §6.5: "migrate runs on boot").
#
# Migration-on-boot itself needs no logic here: `src/main.ts` already calls
# `runMigrations()` in-process, before `app.listen`, on every start — see
# `packages/server/src/db/migrate.ts` (idempotent, advisory-lock-guarded, so
# concurrent replicas booting at once serialize safely instead of racing).
# This wrapper exists as the documented entrypoint hook self-host operators
# can extend (pre-flight checks, secrets fetch, etc.) without duplicating
# that migration call — running it a second time here would just mean
# acquiring the same Postgres advisory lock twice for no benefit.
set -e

exec node dist/main.js
