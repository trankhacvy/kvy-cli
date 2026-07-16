import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Route test files (src/app/routes/*.test.ts) each spin up their own
    // in-memory Postgres (`@electric-sql/pglite`, WASM) plus a real migration
    // run in `beforeAll` — CPU-bound work that vitest fans out across many
    // parallel workers/files at once. Under contention that can occasionally
    // take longer than vitest's default 10s hook timeout, which fails the
    // whole file (reported as "N tests skipped", not a real test failure —
    // the suite never got to run) rather than the individual assertions
    // themselves. Bumped well past the ~10-11s worst case observed locally
    // so a slow parallel start doesn't masquerade as a broken suite.
    hookTimeout: 30_000,
  },
});
