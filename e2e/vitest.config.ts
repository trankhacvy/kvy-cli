import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Boots a real Fastify server + real daemon boot sequence + a simulated
    // session process and walks all 20 conformance steps sequentially — slower
    // than a typical unit test, same rationale as @falcon/server's route tests
    // (see its own vitest.config.ts comment) but more so given the step count.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
