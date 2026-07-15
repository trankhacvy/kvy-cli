const { execSync } = require("node:child_process");

// @falcon/wire is the shared wire-protocol contract package that every other
// workspace package (crypto, cli, server, web) imports as a built dependency.
// Build it right after install so downstream packages never see a missing/stale
// dist/ (mirrors Happy's scripts/postinstall.cjs pattern).
if (process.env.SKIP_FALCON_WIRE_BUILD === "1") {
  console.warn("[postinstall] SKIP_FALCON_WIRE_BUILD=1, skipping @falcon/wire build");
  process.exit(0);
}

execSync("pnpm --filter @falcon/wire build", {
  stdio: "inherit",
});
