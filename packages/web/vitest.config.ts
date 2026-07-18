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
  // tsconfig.json sets `"jsx": "preserve"` (Next's own SWC compiler does the
  // real transform at build time — tsc never touches it). Vite's esbuild
  // pretransform has no bundler-level JSX plugin registered here to fall
  // back to, so without an explicit mode it leaves `.tsx` JSX untransformed
  // as classic `React.createElement` calls with no matching `React` import
  // (this app uses the automatic runtime everywhere, same as Next). W1.10's
  // `app/error.tsx`/`app/not-found.tsx` tests are this file's first ones to
  // actually render a project `.tsx` component's JSX (via
  // `react-dom/server`'s `renderToStaticMarkup`) rather than only import
  // plain functions from one, so this wasn't needed before.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
