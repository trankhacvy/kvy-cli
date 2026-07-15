import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` -> `./src/*` alias from tsconfig.json so modules
      // under test (e.g. button.tsx importing `@/lib/utils`) resolve the
      // same way here as they do under `next build`.
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
