#!/usr/bin/env bash
#
# Compiles the `kvy` CLI into a standalone, no-Node-required executable for
# THIS host's platform/arch, via Node's own Single Executable Applications
# feature (`packages/cli/scripts/native/build.mjs`) — kvy-system-design.md
# §3 originally called for `bun build --compile`, but that was replaced
# after a real end-to-end test found it corrupted native-addon resolution
# between `node-pty` and `@napi-rs/keyring`; Node SEA, once patched
# (`patches/node-pty.patch`, `patches/@napi-rs__keyring.patch`), proved out
# end-to-end against a real live Claude Code session.
#
# No cross-compilation: unlike the old Bun-based version of this script,
# this produces ONE binary, for the platform/arch it's actually running on.
# `.github/workflows/release.yml`'s matrix runs this once per real target OS
# instead of once total.
#
# Prerequisite: `pnpm --filter kvy... build` must already have produced
# `packages/cli/dist/index.mjs` — this compiles *that* bundle, not raw TS
# source, so the exact bundle `tsc`/`pkgroll`/CI type-checked and tested is
# what ships in the binary.
#
# Usage: scripts/build-binaries.sh [outdir]   (default outdir: dist-binaries/)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$ROOT_DIR/packages/cli/dist/index.mjs"

if [ ! -f "$ENTRY" ]; then
  echo "error: $ENTRY not found — run 'pnpm --filter kvy... build' first" >&2
  exit 1
fi

node "$ROOT_DIR/packages/cli/scripts/native/build.mjs" "${1:-dist-binaries}"
