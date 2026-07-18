import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Only `*.test.tsx` files need this — Next.js's own SWC compiler (via
  // `tsconfig.json`'s `"jsx": "preserve"`) handles JSX for the app itself,
  // but vitest runs test files straight through esbuild, which needs an
  // explicit runtime to know what a bare `<div>` compiles to.
  esbuild: {
    jsx: "automatic",
  },
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
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
