#!/bin/sh
# Falcon CLI installer — downloads the standalone `bun build --compile`
# binary (scripts/build-binaries.sh, .github/workflows/release.yml) for this
# machine's platform/arch from GitHub Releases and installs it to
# ~/.falcon/bin/falcon. No Node/npm required for this path; `npm install -g
# falcon` (packages/cli/package.json) is the alternative for machines that
# already have Node.
#
# Usage:
#   curl -fsSL https://<host>/install.sh | sh
#   curl -fsSL https://<host>/install.sh | FALCON_VERSION=v0.2.0 sh
#
# Env overrides:
#   FALCON_REPO      "owner/repo" on GitHub (default: falcon-dev/falcon)
#   FALCON_VERSION   release tag to install, e.g. "v0.2.0" (default: latest)
#   FALCON_HOME_DIR  install root (default: $HOME/.falcon); binary lands in
#                    $FALCON_HOME_DIR/bin/falcon, matching `falcon shim`'s
#                    own ~/.falcon/bin convention (src/shim/paths.ts).
set -eu

REPO="${FALCON_REPO:-falcon-dev/falcon}"
HOME_DIR="${FALCON_HOME_DIR:-$HOME/.falcon}"
BIN_DIR="$HOME_DIR/bin"

say() { printf '%s\n' "$1"; }
err() {
  printf 'falcon: %s\n' "$1" >&2
  exit 1
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) err "unsupported OS '$(uname -s)' — standalone binaries cover macOS and Linux only. Try 'npm install -g falcon' instead." ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    arm64 | aarch64) echo "arm64" ;;
    x86_64 | amd64) echo "x64" ;;
    *) err "unsupported architecture '$(uname -m)'. Try 'npm install -g falcon' instead." ;;
  esac
}

PLATFORM="$(detect_platform)"
ARCH="$(detect_arch)"

if [ "$PLATFORM" = "linux" ] && [ "$ARCH" = "arm64" ]; then
  err "linux-arm64 has no standalone binary yet. Try 'npm install -g falcon' instead."
fi

ASSET="falcon-$PLATFORM-$ARCH"

if [ -n "${FALCON_VERSION:-}" ]; then
  BASE_URL="https://github.com/$REPO/releases/download/$FALCON_VERSION"
else
  BASE_URL="https://github.com/$REPO/releases/latest/download"
fi

command -v curl >/dev/null 2>&1 || err "curl is required to install falcon"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

say "==> downloading $ASSET from $REPO..."
curl -fsSL "$BASE_URL/$ASSET" -o "$TMP_DIR/$ASSET" ||
  err "download failed — check FALCON_REPO/FALCON_VERSION and that a release exists for $PLATFORM/$ARCH"
curl -fsSL "$BASE_URL/$ASSET.sha256" -o "$TMP_DIR/$ASSET.sha256" ||
  err "checksum download failed"

say "==> verifying checksum..."
(
  cd "$TMP_DIR"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$ASSET.sha256"
  else
    shasum -a 256 -c "$ASSET.sha256"
  fi
) || err "checksum verification failed — download may be corrupt or tampered"

mkdir -p "$BIN_DIR"
mv "$TMP_DIR/$ASSET" "$BIN_DIR/falcon"
chmod +x "$BIN_DIR/falcon"

say "==> installed falcon to $BIN_DIR/falcon"

# --- PATH setup ---------------------------------------------------------
# Same marker block `falcon shim install` uses for ~/.falcon/bin
# (packages/cli/src/shim/rcBlock.ts's BLOCK_START/BLOCK_END) — kept
# byte-for-byte in sync so a later `falcon shim install/uninstall` treats
# this installer's PATH line as already present instead of writing a
# second copy of the same export.
BLOCK_START="# >>> falcon shell shim >>>"
BLOCK_END="# <<< falcon shell shim <<<"

already_on_path=0
case ":$PATH:" in
  *":$BIN_DIR:"*) already_on_path=1 ;;
esac

if [ "$already_on_path" = "1" ]; then
  say "==> $BIN_DIR is already on PATH"
else
  # EXPORT_LINE is built from the actual $BIN_DIR (which already honors
  # FALCON_HOME_DIR) rather than a hardcoded "$HOME/.falcon/bin" literal, so
  # a FALCON_HOME_DIR override installs the binary and points PATH at the
  # same directory. $PATH itself stays unexpanded (escaped) so it's
  # resolved dynamically when the rc file is sourced.
  case "$(basename "${SHELL:-}")" in
    zsh)
      RC_FILE="$HOME/.zshrc"
      EXPORT_LINE="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    bash)
      RC_FILE="$HOME/.bashrc"
      EXPORT_LINE="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
    fish)
      RC_FILE="$HOME/.config/fish/config.fish"
      EXPORT_LINE="set -gx PATH \"$BIN_DIR\" \$PATH"
      ;;
    *)
      RC_FILE="$HOME/.profile"
      EXPORT_LINE="export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac

  if [ -f "$RC_FILE" ] && grep -qF "$BLOCK_START" "$RC_FILE" 2>/dev/null; then
    say "==> PATH block already present in $RC_FILE"
  else
    mkdir -p "$(dirname "$RC_FILE")"
    if [ -s "$RC_FILE" ] 2>/dev/null; then
      printf '\n' >>"$RC_FILE"
    fi
    printf '%s\n%s\n%s\n' "$BLOCK_START" "$EXPORT_LINE" "$BLOCK_END" >>"$RC_FILE"
    say "==> added $BIN_DIR to PATH in $RC_FILE — restart your shell or run: source $RC_FILE"
  fi
fi

say "==> run 'falcon --version' to verify (after restarting your shell / sourcing your rc file)"
