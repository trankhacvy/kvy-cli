import path from "node:path";
import type { NextConfig } from "next";

// Static export: falcon-web is a client-only PWA, statically exported and
// served from an origin separate from the API server (design §5.3 trust
// boundary, §9 stack). Next never server-renders user content here — it's
// ciphertext to the server anyway — so App Router pages are prerendered at
// build time into a plain `out/` directory deployable to any static host/CDN.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    // No image optimization server exists for a static export.
    unoptimized: true,
  },
  // Pin the workspace root explicitly (this is the pnpm monorepo root, two
  // levels up from packages/web) so Next's file tracing doesn't guess wrong
  // when it finds another lockfile above the repo, e.g. inside a worktree.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
};

export default nextConfig;
