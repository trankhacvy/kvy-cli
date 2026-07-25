#!/usr/bin/env node
// Bundles src/crypto/worker.ts into public/crypto-worker.js as a standalone,
// self-contained ES module — served as a plain static file at a fixed path
// instead of relying on webpack/Turbopack's `new Worker(new URL(...))`
// chunk-splitting support. That support is inconsistent across bundlers/hosts
// for this app's static export (confirmed: works with a local `next build`
// but the deployed Vercel build requests a chunk URL that 404s), so this
// sidesteps it entirely — no dynamic chunk URL to get wrong, just a fixed
// file any static host serves the same way factory.ts always expected.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// Combines tsconfig.json's "@/*" -> "./src/*" path alias with next.config.ts's
// webpack() extensionAlias: source imports use explicit `.js` suffixes
// against `.ts`/`.tsx` files (the standard "moduleResolution": "bundler"
// pattern), for both `@/...` and relative imports. esbuild has no such alias
// built in, so resolve both by hand before falling back to esbuild's default
// resolution (which handles real `.js` files, e.g. inside node_modules) —
// done as one plugin so the `@/` rewrite still gets the `.js`->`.ts` swap
// (esbuild stops calling further onResolve hooks once one returns a result).
const localImportPlugin = {
  name: "local-import-resolver",
  setup(buildApi) {
    buildApi.onResolve({ filter: /^(@\/|\.)/ }, (args) => {
      const rewritten = args.path.startsWith("@/")
        ? path.join(root, "src", args.path.slice(2))
        : path.resolve(args.resolveDir, args.path);
      if (!rewritten.endsWith(".js")) return { path: rewritten };
      const withoutExt = rewritten.slice(0, -3);
      for (const ext of [".ts", ".tsx"]) {
        const candidate = withoutExt + ext;
        if (existsSync(candidate)) return { path: candidate };
      }
      return { path: rewritten };
    });
  },
};

await build({
  entryPoints: [path.join(root, "src/crypto/worker.ts")],
  outfile: path.join(root, "public/crypto-worker.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  minify: true,
  sourcemap: false,
  logLevel: "info",
  // Same inlining Next.js does for NEXT_PUBLIC_* vars in the main bundle —
  // this standalone bundle needs its own, since it isn't built by Next. Only
  // API_URL is actually used on the worker's import path (worker-handler.ts),
  // but esbuild still evaluates `lib/config.ts`'s other top-level
  // `process.env.NEXT_PUBLIC_*` reads as part of that module even though
  // their exports are unused — `process` doesn't exist in a browser Worker,
  // so the blanket `process.env` fallback keeps any of those from throwing
  // a ReferenceError at module-load time; the specific API_URL define below
  // takes precedence over it for that one access.
  define: {
    "process.env": "{}",
    "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(process.env.NEXT_PUBLIC_API_URL ?? ""),
  },
  plugins: [localImportPlugin],
});
