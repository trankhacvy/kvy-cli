#!/usr/bin/env bash
#
# Compiles the `falcon` CLI into standalone, no-Node-required executables
# via `bun build --compile` (falcon-system-design.md §3: "npm package +
# `bun build --compile` standalone binaries (mac arm64/x64, linux x64)"),
# for the `curl | sh` installer (scripts/install.sh) to download.
#
# Prerequisite: `pnpm --filter falcon... build` must already have produced
# `packages/cli/dist/index.mjs` — this script compiles *that* bundle, not
# raw TS source, so the exact bundle `tsc`/`pkgroll`/CI type-checked and
# tested is what ships in the binary.
#
# Bun cross-compiles: a single host (any OS) can produce all three target
# binaries via `--target=bun-<os>-<arch>` — no macOS runner is needed for
# the darwin binaries. See https://bun.sh/docs/bundler/executables#cross-compiling
#
# Usage: scripts/build-binaries.sh [outdir]   (default outdir: dist-binaries/)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$ROOT_DIR/packages/cli"
ENTRY="$CLI_DIR/dist/index.mjs"
OUT_DIR="$(cd "$ROOT_DIR" && mkdir -p "${1:-dist-binaries}" && cd "${1:-dist-binaries}" && pwd)"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build standalone binaries — https://bun.sh" >&2
  exit 1
fi

if [ ! -f "$ENTRY" ]; then
  echo "error: $ENTRY not found — run 'pnpm --filter falcon... build' first" >&2
  exit 1
fi

VERSION="$(node -p "require('$CLI_DIR/package.json').version")"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

# bun target triple -> falcon binary suffix (must match install.sh's
# platform/arch detection, which builds the same "$platform-$arch" string).
TARGETS="bun-darwin-arm64:darwin-arm64 bun-darwin-x64:darwin-x64 bun-linux-x64:linux-x64"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

for pair in $TARGETS; do
  bun_target="${pair%%:*}"
  suffix="${pair##*:}"
  outfile="$OUT_DIR/falcon-$suffix"

  echo "==> building falcon-$suffix ($bun_target, v$VERSION)"
  bun build "$ENTRY" \
    --compile \
    --minify \
    --target="$bun_target" \
    --define:__FALCON_CLI_VERSION__="\"$VERSION\"" \
    --outfile="$outfile"

  chmod +x "$outfile"
  ( cd "$OUT_DIR" && sha256_file "falcon-$suffix" > "falcon-$suffix.sha256" )
done

# Plain-text version marker (falcon-system-design.md §13 / plan.md §16 "4.3
# Distribution & self-host": CLI self-update reads this off the `cli-latest`
# rolling release tag to decide whether an installed falcon is out of date,
# without needing to know the exact vX.Y.Z tag up front).
echo "$VERSION" > "$OUT_DIR/VERSION"

echo "==> built binaries in $OUT_DIR:"
ls -la "$OUT_DIR"
