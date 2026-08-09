import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // bootstrap.integration.test.ts spins up PGlite + migrations in beforeAll,
    // which can exceed the default 10s hook timeout in CI under load.
    hookTimeout: 30_000,
    // Real PIN-based KDF work (pin.test.ts) and other CPU-bound tests can exceed
    // vitest's default 5s test timeout when this package's suite runs concurrently
    // with the rest of the monorepo's (turbo fans out web/server/cli test tasks in
    // parallel) — same contention reasoning as hookTimeout above.
    testTimeout: 30_000,
  },
});
