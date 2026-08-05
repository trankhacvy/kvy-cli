import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // bootstrap.integration.test.ts spins up PGlite + migrations in beforeAll,
    // which can exceed the default 10s hook timeout in CI under load.
    hookTimeout: 30_000,
  },
});
