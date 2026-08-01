// Compiles the `kvy` CLI into a standalone, no-Node-required executable via
// Node's own Single Executable Applications feature (`node:sea` +
// `postject`) — falcon-system-design.md §3 originally called for Bun, but
// this was rewritten to Node SEA after a real end-to-end test proved it
// (Bun's compiled binaries corrupted native-addon resolution between
// `node-pty` and `@napi-rs/keyring`; SEA, once patched, worked for a real
// live Claude Code session — pty spawn, resize, keyring auth, clean exit).
//
// No cross-compilation: unlike the old Bun-based script, this can only
// produce a binary for the platform/arch it's actually running on — CI must
// run this once per real target OS (see `.github/workflows/release.yml`'s
// matrix), not once for all of them.
//
// Prerequisite: `pnpm --filter kvy... build` must already have produced
// `packages/cli/dist/index.mjs` — this embeds *that* exact, already
// typechecked/tested bundle; it does not re-bundle from source.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import { resolveNativeAssets } from "./native-assets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(__dirname, "..", "..");
const repoRoot = resolve(cliDir, "..", "..");
const distEntry = join(cliDir, "dist", "index.mjs");
const launcherEntry = join(cliDir, "scripts", "kvy_claude_launcher.cjs");

// `dist/index.mjs` (pkgroll's npm-publish output) deliberately leaves every
// plain npm dependency external — correct for `npm install -g kvy`, where a
// real `node_modules` sits next to it, but fatal for the compiled binary,
// which extracts `dist/index.mjs` alone into an empty temp directory with
// nothing else around it. Only the three genuinely *native* dependencies
// stay external here (a native `.node` addon can't be inlined as JS at all
// — they're handled separately via `resolveNativeAssets()`/`entry.cjs`);
// every other import gets bundled for real.
const BUNDLE_EXTERNAL = ["node-pty", "@napi-rs/keyring", "@node-rs/argon2"];

const STUBS_DIR = join(__dirname, "stubs");

async function bundleForNativeBuild(entryPath, outDir) {
  const outfile = join(outDir, "index.mjs");
  await esbuild.build({
    entryPoints: [entryPath],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    external: BUNDLE_EXTERNAL,
    // `react-devtools-core`: see stubs/react-devtools-core.mjs's own doc
    // comment for why this needs a real (empty) module instead of just
    // being left external.
    alias: { "react-devtools-core": join(STUBS_DIR, "react-devtools-core.mjs") },
    // Bundled CJS deps that do their own environment-detecting
    // `require('crypto')` (tweetnacl's `nacl-fast.js`, guarded/conditional,
    // not a normal top-level require) hit esbuild's "Dynamic require of X is
    // not supported" runtime throw in ESM output — esbuild's own shim for
    // leftover `require()` calls only throws in that format, it doesn't
    // delegate to a real one. This banner replaces it with an actual
    // `createRequire`-backed `require`, esbuild's documented fix for exactly
    // this ESM-bundling gap.
    banner: {
      js: "import { createRequire as __kvyCreateRequire } from 'node:module'; const require = __kvyCreateRequire(import.meta.url);",
    },
    logLevel: "info",
  });
  return outfile;
}

const outDirArg = process.argv[2] ?? "dist-binaries";
const outDir = resolve(repoRoot, outDirArg);

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function run(command, args, options = {}) {
  console.log(`==> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

async function main() {
  if (!existsSync(distEntry)) {
    console.error(`error: ${distEntry} not found — run 'pnpm --filter kvy... build' first`);
    process.exit(1);
  }
  if (!existsSync(launcherEntry)) {
    console.error(`error: ${launcherEntry} not found — run 'pnpm --filter kvy... build' first`);
    process.exit(1);
  }

  const version = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8")).version;
  const suffix = `${process.platform}-${process.arch}`;
  console.log(`==> Native build (kvy-${suffix}, v${version})`);

  const { assets: nativeAssets, packageTrees } = resolveNativeAssets();
  const buildDir = mkdtempSync(join(tmpdir(), "kvy-sea-build-"));

  console.log("==> bundling every non-native dependency for real (esbuild)");
  const selfContainedBundle = await bundleForNativeBuild(distEntry, buildDir);

  // A minimal package.json, not the real one — `entry.cjs` extracts this
  // alongside the bundle so `index.ts`'s `readVersion()` can find it via the
  // exact same relative-path lookup it uses for a normal npm install; only
  // `.version` is ever actually read at runtime.
  const minimalPkgJsonPath = join(buildDir, "package.json");
  writeFileSync(minimalPkgJsonPath, JSON.stringify({ version }));

  // What `entry.cjs` reconstructs as a real `node_modules/<pkg>/...` for
  // node-pty/keyring/argon2 — see native-assets.mjs's module doc comment for
  // why Node's own ESM resolver needs this to exist at all, separate from
  // the (already-patched) native `.node` loading those packages do internally.
  const packageTreesManifestPath = join(buildDir, "package-trees-manifest.json");
  writeFileSync(
    packageTreesManifestPath,
    JSON.stringify(
      packageTrees.map((tree) => ({
        name: tree.name,
        files: tree.files.map((f) => ({ assetKey: f.assetKey, relPath: f.relPath })),
      })),
    ),
  );

  const seaAssets = {
    "dist-bundle": selfContainedBundle,
    "launcher-script": launcherEntry,
    "package-json": minimalPkgJsonPath,
    "package-trees-manifest": packageTreesManifestPath,
  };
  for (const [key, { path: assetPath }] of Object.entries(nativeAssets)) {
    seaAssets[key] = assetPath;
  }

  const seaConfigPath = join(buildDir, "sea-config.json");
  const blobPath = join(buildDir, "sea-prep.blob");
  writeFileSync(
    seaConfigPath,
    JSON.stringify(
      {
        main: join(__dirname, "entry.cjs"),
        output: blobPath,
        disableExperimentalSEAWarning: true,
        assets: seaAssets,
      },
      null,
      2,
    ),
  );

  run(process.execPath, ["--experimental-sea-config", seaConfigPath]);

  mkdirSync(outDir, { recursive: true });
  const outfile = join(outDir, `kvy-${suffix}${process.platform === "win32" ? ".exe" : ""}`);
  copyFileSync(process.execPath, outfile);
  if (process.platform !== "win32") chmodSync(outfile, 0o755);

  if (process.platform === "darwin") {
    run("codesign", ["--remove-signature", outfile]);
  }

  // `shell: true` on Windows only: `npx` there is `npx.cmd`, a shell shim,
  // not a directly-executable binary — `execFileSync` without a shell hits
  // `ENOENT` trying to spawn it by that exact name (confirmed against a
  // real Windows runner). macOS/Linux resolve `npx` directly and don't need
  // this; skip it there rather than pay the injection-surface cost for no
  // reason (every arg here is a fixed literal, no untrusted input, so this
  // is safe either way, but no shell is still the safer default).
  run(
    "npx",
    [
      "--yes",
      "postject",
      outfile,
      "NODE_SEA_BLOB",
      blobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
    ],
    { shell: process.platform === "win32" },
  );

  if (process.platform === "darwin") {
    // Ad-hoc signing only (`-`), not a real Apple Developer ID — deliberate,
    // matches the project's decision to ship unsigned for now (open source,
    // Gatekeeper workaround documented for users who hit it) rather than pay
    // for + wire up notarization before there's a real user base to justify it.
    run("codesign", ["--sign", "-", outfile]);
  }

  const hash = sha256File(outfile);
  writeFileSync(`${outfile}.sha256`, `${hash}  kvy-${suffix}\n`);
  writeFileSync(join(outDir, "VERSION"), `${version}\n`);

  rmSync(buildDir, { recursive: true, force: true });

  console.log(`==> built ${outfile}`);
  console.log(`    sha256: ${hash}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
