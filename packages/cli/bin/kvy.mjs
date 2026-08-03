#!/usr/bin/env node
// Bin shim — re-exec node with `--no-warnings` so Node's experimental-feature
// banners never land on stdout/stderr. Those channels are reserved for the
// real provider TUI (Claude Code / Codex) during local-mode session spawning;
// keeping the shim clean avoids a footgun there.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

const result = spawnSync(process.execPath, ["--no-warnings", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`kvy: failed to start (${result.error.message})\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
