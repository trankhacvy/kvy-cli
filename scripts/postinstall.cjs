const { execSync } = require("node:child_process");
const { chmodSync, existsSync, readdirSync } = require("node:fs");
const path = require("node:path");

// node-pty ships a native `spawn-helper` binary (macOS only, used to spawn the
// PTY child through a login shell). pnpm's content-addressable store
// sometimes restores it without the executable bit, silently breaking every
// local PTY session until someone `chmod +x`s it by hand. Walk the pnpm store
// for it and fix the bit on every install; a no-op on Linux, where node-pty
// doesn't ship this file at all.
function chmodSpawnHelpers(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodSpawnHelpers(full);
    } else if (entry.isFile() && entry.name === "spawn-helper") {
      chmodSync(full, 0o755);
      console.warn(`[postinstall] chmod +x ${full}`);
    }
  }
}

function fixNodePtySpawnHelper() {
  const pnpmDir = path.join(__dirname, "..", "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) return;

  for (const entry of readdirSync(pnpmDir)) {
    if (!entry.startsWith("node-pty@")) continue;
    chmodSpawnHelpers(path.join(pnpmDir, entry, "node_modules", "node-pty"));
  }
}

// @kvy/wire is the shared wire-protocol contract package that every other
// workspace package (crypto, cli, server, web) imports as a built dependency.
// Build it right after install so downstream packages never see a missing/stale
// dist/.
if (process.env.SKIP_KVY_WIRE_BUILD === "1") {
  console.warn("[postinstall] SKIP_KVY_WIRE_BUILD=1, skipping @kvy/wire build");
} else {
  execSync("pnpm --filter @kvy/wire build", {
    stdio: "inherit",
  });
}

try {
  fixNodePtySpawnHelper();
} catch (err) {
  console.warn(`[postinstall] node-pty spawn-helper chmod skipped: ${err.message}`);
}
