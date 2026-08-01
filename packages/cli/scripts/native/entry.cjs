// The actual "main" of the compiled `kvy` binary (Node SEA's `main` field
// must be a real CJS-loadable script — see build.mjs's doc comment for why).
// Everything here is boot plumbing; the real CLI logic never got rewritten
// or re-bundled for this — it's the exact same `dist/index.mjs` the npm
// package ships, embedded as a raw SEA asset (not as the SEA `main` blob
// itself, which only supports CJS) and loaded from a real extracted file via
// a genuine dynamic `import()`, so its own ESM/top-level-await code (e.g.
// ink's `yoga-layout` WASM loader) runs completely unmodified.
//
// The extraction directory is deliberately shaped exactly like the real npm
// package (`dist/index.mjs`, `scripts/kvy_claude_launcher.cjs`,
// `package.json`) — `index.ts`'s `packageRootDir()` finds sibling files by
// walking up from its own `import.meta.url`, and this way that relative-path
// math resolves correctly without any special-casing on the CLI's side: the
// version, the bundle path, and the launcher script path all "just work" the
// same way they do for a normal `npm install -g kvy`.
//
// Native modules (`node-pty`, `@napi-rs/keyring`, `@node-rs/argon2`) need two
// separate things reconstructed, neither of which can just be embedded
// directly as part of the bundle above:
//
//  1. Their plain-JS glue code (`lib/index.js` and friends) plus
//     `package.json`, laid out as a real `node_modules/<pkg>/...` next to
//     `dist/` — `dist/index.mjs`'s own `import { spawn } from 'node-pty'`
//     needs Node's *own* ESM resolver to find a real package on disk via
//     the normal upward `node_modules` walk; esbuild left these as external
//     specifically because a native addon can't be bundled as JS, but that
//     means Node has to be able to find them the ordinary way instead.
//  2. Their actual native `.node` addon for this platform — a real compiled
//     binary, embedded separately and extracted to its own directory below.
//     All three packages were patched (`patches/node-pty.patch`,
//     `patches/@napi-rs__keyring.patch`, `patches/@node-rs__argon2.patch`)
//     to load this via an env-var override instead of their stock
//     relative-path probing, which assumes a real on-disk layout that
//     doesn't exist inside a single-executable binary.
const sea = require("node:sea");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function extract(assetKey, destPath, executable) {
  const blob = sea.getAsset(assetKey);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(blob));
  if (executable) fs.chmodSync(destPath, 0o755);
  return destPath;
}

const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "kvy-"));

// Package-shaped layout, so `packageRootDir()` (index.ts) resolves correctly.
const distPath = extract("dist-bundle", path.join(pkgDir, "dist", "index.mjs"));
extract("launcher-script", path.join(pkgDir, "scripts", "kvy_claude_launcher.cjs"));
extract("package-json", path.join(pkgDir, "package.json"));

// A real (if synthetic) `node_modules/<pkg>/...` for node-pty/keyring/argon2
// — see the module doc comment above, point 1. `build.mjs`
// (`native-assets.mjs`) is the single source of truth for exactly which
// files each package needs; this just replays whatever it recorded.
const packageTreesManifestPath = extract(
  "package-trees-manifest",
  path.join(pkgDir, "package-trees-manifest.json"),
);
const packageTrees = JSON.parse(fs.readFileSync(packageTreesManifestPath, "utf8"));
for (const { name, files } of packageTrees) {
  for (const { assetKey, relPath } of files) {
    extract(assetKey, path.join(pkgDir, "node_modules", name, relPath));
  }
}

// Native addons: any real absolute directory works, resolved by the two
// patched loaders via env var, not by relative position.
const nativeDir = path.join(pkgDir, "native");
extract("pty-node", path.join(nativeDir, "pty.node"));
if (process.platform === "win32") {
  extract("conpty-node", path.join(nativeDir, "conpty.node"));
  extract("conpty-console-list-node", path.join(nativeDir, "conpty_console_list.node"));
} else {
  extract("spawn-helper", path.join(nativeDir, "spawn-helper"), true);
}
process.env.KVY_PTY_NATIVE_DIR = nativeDir;

const keyringPath = extract("keyring-node", path.join(nativeDir, "keyring.node"));
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = keyringPath;

const argon2Path = extract("argon2-node", path.join(nativeDir, "argon2.node"));
process.env.KVY_ARGON2_NATIVE_PATH = argon2Path;

(async () => {
  const { main } = await import(`file://${distPath}`);
  const result = main();
  const exitCode = result instanceof Promise ? await result : result;
  process.exit(exitCode);
})().catch((err) => {
  console.error("kvy: fatal startup error:", err);
  process.exit(1);
});
