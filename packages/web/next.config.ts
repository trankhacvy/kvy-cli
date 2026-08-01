import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

// Static export: kvy-web is a client-only PWA, statically exported and
// served from an origin separate from the API server (design §5.3 trust
// boundary, §9 stack). Next never server-renders user content here — it's
// ciphertext to the server anyway — so App Router pages are prerendered at
// build time into a plain `out/` directory deployable to any static host/CDN.
//
// `output: "export"` is intentionally applied only for `next build`, not for
// `next dev` (see the phase check below). Next's export machinery expects to
// run once, to completion, against a server that then exits; under `next dev`
// the manifest/chunk files it produces get raced by the dev server's own
// on-demand recompilation and page disposal, and `next dev` can end up
// serving from a `.next/` that export left mid-rewrite — the first request
// after startup succeeds, but the dev server's background bookkeeping (e.g.
// on-demand entry disposal after idle) then finds `routes-manifest.json` /
// `prerender-manifest.json` gone and every subsequent request 500s with
// MODULE_NOT_FOUND from `webpack-runtime.js`. `next build` (the CI-verified
// path) and the resulting static export are unaffected — only interactive
// `next dev` iteration is. This is the documented workaround: gate `output`
// on the build phase so `next dev` runs Next's normal (non-export) dev
// server, which doesn't hit this interaction.
const nextConfig = (phase: string): NextConfig => ({
  ...(phase === PHASE_DEVELOPMENT_SERVER ? {} : { output: "export" as const }),
  trailingSlash: true,
  images: {
    // No image optimization server exists for a static export.
    unoptimized: true,
  },
  // Subresource Integrity (plan.md §16 "4.3 Distribution & self-host": "strict
  // CSP+SRI" for the split-origin web deploy). Next stamps an `integrity`
  // attribute (sha256 of the file's contents) onto every `<script>`/`<link>`
  // tag it emits for its own build output, so a compromised/tampered static
  // host or CDN in front of the split web origin can't silently swap out a
  // JS/CSS bundle without the browser refusing to execute it. This is the one
  // half of "CSP+SRI" that's a build-time concern; the CSP header itself is
  // set at serve time by `deploy/web/default.conf.template`.
  //
  // Off on Vercel (`process.env.VERCEL` — set automatically by every Vercel
  // build, docs.vercel.com/deployments/environments): confirmed twice, with a
  // cache-free `curl`/Playwright client, that Vercel's edge served an
  // `index.html` and a `webpack-*.js` chunk from two different builds whose
  // content didn't match each other's baked-in hash — SRI then did exactly
  // its job and blocked the mismatched chunk, but since that chunk *is* the
  // webpack runtime, nothing else could execute either: a silent, totally
  // blank page with no console error a user would ever see reported (the
  // browser drops the "resource blocked" message before Next's own
  // error-reporting code has even loaded). This is a real gap in Vercel's
  // (or this project's Vercel config's) atomic-deploy guarantee, not
  // something `next.config.ts` can fix from this side — self-host's own
  // Docker image build + nginx serve never goes through that CDN layer, so
  // SRI stays on there.
  experimental: {
    ...(process.env.VERCEL
      ? {}
      : {
          sri: {
            algorithm: "sha256",
          },
        }),
  },
  // Pin the workspace root explicitly (this is the pnpm monorepo root, two
  // levels up from packages/web) so Next's file tracing doesn't guess wrong
  // when it finds another lockfile above the repo, e.g. inside a worktree.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  webpack(config) {
    // `src/crypto/*` (the crypto-bridge worker bridge, shared with the
    // isomorphic @kvy/crypto package), the reducer (`src/sync/reducer/`),
    // and other `tsconfig.base.json` "moduleResolution": "bundler" code all
    // use explicit `.js`-suffixed relative imports against `.ts`/`.tsx`
    // source files — the standard pattern for that resolution mode, which
    // `tsc`/`vitest` already resolve fine. Webpack's default resolver has no
    // such alias, so without this it 404s on every one of those imports as
    // soon as a page actually pulls in the crypto bridge, the reducer, or
    // anything else under `packages/web/src` bundled this way.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
});

export default nextConfig;
