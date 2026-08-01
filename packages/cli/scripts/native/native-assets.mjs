// Resolves the real, on-disk files this host's `pnpm install` actually
// pulled down for `node-pty`, `@napi-rs/keyring`, and `@node-rs/argon2` —
// the three native dependencies `kvy`'s compiled binary needs (the last one
// only transitively, via `@kvy/crypto`). Node SEA has no cross-compilation
// (unlike Bun): whatever host runs this script IS the target platform, so
// there is no per-target matrix here — only "what does THIS host have."
//
// Two different kinds of file get resolved:
//
//  1. Each package's native `.node` (+ helper executable, on non-Windows)
//     addon for THIS platform/arch — the actual compiled code.
//  2. Each package's own plain-JS glue code (`lib/index.js` and friends) and
//     `package.json`. These stay external from the esbuild bundle (a native
//     addon can't be inlined as JS at all), which means Node's *own* ESM
//     resolver has to be able to find a real `node_modules/<pkg>/` on disk
//     for their bare-specifier imports (`import { spawn } from 'node-pty'`)
//     to resolve at all — `entry.cjs` reconstructs exactly that layout from
//     these files at boot, in a real (if synthetic) temp `node_modules`.
//     Their own patched loaders (`patches/*.patch`) are what then finds the
//     *native* file from (1), via the env-var override — this part just
//     gets Node far enough to actually load and run that patched code.
//
// node-pty ships its own platform prebuilds directly inside its package
// (`prebuilds/<platform>-<arch>/`). `@napi-rs/keyring` and `@node-rs/argon2`
// both ship a thin loader package plus one *separate* npm optionalDependency
// per platform+libc — only the one matching this host is ever actually
// installed, so each has to be resolved by name, not just walked on disk.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

const require = createRequire(import.meta.url);

function napiPlatformPackageName(scope, platform, arch) {
  if (platform === "darwin") return `${scope}-darwin-${arch}`;
  if (platform === "win32") return `${scope}-win32-${arch}-msvc`;
  if (platform === "linux") {
    // musl (Alpine) hosts need the `-musl` variant instead; detecting that
    // reliably needs `/etc/os-release` or `ldd --version` sniffing, which
    // these packages' own loaders already do at runtime (see their
    // `isMusl()`) — this build script only supports the far more common gnu
    // (glibc) case for now. A musl CI runner will fail loudly here, not
    // silently ship a binary missing native support.
    return `${scope}-linux-${arch}-gnu`;
  }
  throw new Error(`kvy native build: unsupported platform "${platform}" for ${scope}`);
}

/**
 * Resolves a package's directory by chaining `require.resolve` hops through
 * intermediate packages — needed because pnpm's strict, non-hoisting
 * resolution only lets a package `require()` its own *direct* dependencies.
 * `@node-rs/argon2-darwin-arm64`, for instance, is only reachable by first
 * resolving `@kvy/crypto` (a direct dependency of this CLI package), then
 * `@node-rs/argon2` from *within* crypto's scope, then the platform package
 * from *within argon2's* scope — each hop re-anchors the `require` used for
 * the next one.
 *
 * Resolves each hop's bare package name (its main entry), not
 * `<name>/package.json` — some packages here (`@kvy/crypto`, built by
 * pkgroll) declare a strict `"exports"` map that doesn't expose
 * `./package.json` as a subpath, which makes `require.resolve` refuse it
 * even though the package itself resolves fine. Walking up from the
 * resolved main file to the nearest `package.json` (matched by `"name"`,
 * not just "the first one found" — a workspace root sits above every
 * package here too) sidesteps that entirely: reading a file directly with
 * `fs.readFileSync` never goes through Node's exports-map enforcement,
 * only `require`/`import` do.
 */
function findPackageRoot(fromFile, packageName) {
  let dir = dirname(fromFile);
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkgJson = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkgJson.name === packageName) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `kvy native build: couldn't find ${packageName}'s package root above ${fromFile}`,
  );
}

function resolvePackageDir(...packageNamesFromOutermostToInnermost) {
  let anchor = require;
  let dir;
  for (const packageName of packageNamesFromOutermostToInnermost) {
    const mainFile = anchor.resolve(packageName);
    dir = findPackageRoot(mainFile, packageName);
    anchor = createRequire(join(dir, "noop.js"));
  }
  return dir;
}

function nodeFileFromPackage(packageDir) {
  const pkgJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (!pkgJson.main) {
    throw new Error(`kvy native build: ${packageDir}'s package.json has no "main" .node file`);
  }
  return join(packageDir, pkgJson.main);
}

/** Every `.js`/`package.json` file directly inside `dir` (non-recursive) — the plain glue code a package needs to run, deliberately excluding `.d.ts`/`README`/`LICENSE`/anything else not read at runtime. */
function jsFilesIn(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".js") || name === "package.json")
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => join(dir, name));
}

let assetCounter = 0;
function nextAssetKey(prefix) {
  assetCounter += 1;
  return `${prefix}-${assetCounter}`;
}

/**
 * Registers a package's plain-JS files (see module doc comment, point 2) so
 * `entry.cjs` can reconstruct a real `node_modules/<packageName>/...` for
 * it. `files` are absolute paths; `packageRootDir` anchors what their
 * reconstructed *relative* path should be (so `lib/index.js` stays
 * `lib/index.js`, not just `index.js`, for packages like node-pty whose
 * `package.json` "main" points into a subdirectory).
 */
function packageTree(assets, packageTrees, packageName, packageRootDir, files) {
  const tree = { name: packageName, files: [] };
  for (const absPath of files) {
    const assetKey = nextAssetKey("pkgjs");
    assets[assetKey] = { path: absPath };
    tree.files.push({ assetKey, relPath: relative(packageRootDir, absPath) });
  }
  packageTrees.push(tree);
}

/**
 * @returns {{
 *   assets: Record<string, { path: string, executable?: boolean }>,
 *   packageTrees: Array<{ name: string, files: Array<{ assetKey: string, relPath: string }> }>,
 * }}
 */
export function resolveNativeAssets() {
  const platform = process.platform;
  const arch = process.arch;

  const assets = {};
  const packageTrees = [];

  const ptyDir = resolvePackageDir("node-pty");
  const ptyPrebuilds = join(ptyDir, "prebuilds", `${platform}-${arch}`);
  if (!existsSync(ptyPrebuilds)) {
    throw new Error(`kvy native build: no node-pty prebuilds at ${ptyPrebuilds}`);
  }

  assets["pty-node"] = { path: join(ptyPrebuilds, "pty.node") };

  if (platform === "win32") {
    // Windows node-pty needs ConPTY's own native module alongside pty.node —
    // see node-pty's windowsTerminal.js: `require('../build/Release/conpty.node')`
    // follows the same relative-to-native-module-dir convention pty.node does.
    assets["conpty-node"] = { path: join(ptyPrebuilds, "conpty.node") };
    assets["conpty-console-list-node"] = { path: join(ptyPrebuilds, "conpty_console_list.node") };
  } else {
    // Unix: node-pty forks through a small companion executable, not just a
    // .node addon — see lib/unixTerminal.js's `native.dir + '/spawn-helper'`.
    assets["spawn-helper"] = { path: join(ptyPrebuilds, "spawn-helper"), executable: true };
  }
  packageTree(assets, packageTrees, "node-pty", ptyDir, [
    join(ptyDir, "package.json"),
    ...jsFilesIn(join(ptyDir, "lib")),
  ]);

  const keyringPkg = napiPlatformPackageName("@napi-rs/keyring", platform, arch);
  const keyringDir = resolvePackageDir("@napi-rs/keyring", keyringPkg);
  assets["keyring-node"] = { path: nodeFileFromPackage(keyringDir) };
  const keyringHostDir = resolvePackageDir("@napi-rs/keyring");
  packageTree(assets, packageTrees, "@napi-rs/keyring", keyringHostDir, jsFilesIn(keyringHostDir));

  const argon2Pkg = napiPlatformPackageName("@node-rs/argon2", platform, arch);
  const argon2Dir = resolvePackageDir("@kvy/crypto", "@node-rs/argon2", argon2Pkg);
  assets["argon2-node"] = { path: nodeFileFromPackage(argon2Dir) };
  const argon2HostDir = resolvePackageDir("@kvy/crypto", "@node-rs/argon2");
  packageTree(assets, packageTrees, "@node-rs/argon2", argon2HostDir, jsFilesIn(argon2HostDir));

  return { assets, packageTrees };
}
