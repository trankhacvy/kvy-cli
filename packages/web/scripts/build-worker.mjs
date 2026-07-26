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
import { readFile } from "node:fs/promises";
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
  // `?? ""` here used to DEFEAT `lib/config.ts`'s own `?? "http://localhost:3005"` fallback:
  // `??` triggers on undefined, not on an empty string, so an unset var baked API_URL as ""
  // and every worker-side fetch became a same-origin relative URL against the WEB origin.
  // That is the whole of auth-ux-overhaul-e2e-results.md E2E-4.1/6.1 — a reload signed the
  // user out because the refresh call went to :3000 and 404'd. Emit the define only when the
  // var is actually set; otherwise let `process.env` -> `{}` yield `undefined` and config.ts
  // apply its own default, exactly as the main bundle does.
  define: {
    "process.env": "{}",
    ...(process.env.NEXT_PUBLIC_API_URL
      ? {
          "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(process.env.NEXT_PUBLIC_API_URL),
        }
      : {}),
  },
  plugins: [localImportPlugin],
});

// Fail the build rather than ship a worker that silently talks to the wrong origin. The
// bundle is minified and the URL is concatenated at runtime (`fetch(`${API_URL}/v1/auth/…`)`),
// so don't pattern-match the final URL — assert the exact base string this build should have
// inlined is present verbatim.
const expectedBase = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3005").replace(
  /\/+$/,
  "",
);
const emitted = await readFile(path.join(root, "public/crypto-worker.js"), "utf8");
if (!emitted.includes(JSON.stringify(expectedBase))) {
  throw new Error(
    `build-worker: expected the bundle to inline ${expectedBase} as its API base — ` +
      "check NEXT_PUBLIC_API_URL",
  );
}
