import { readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "out");

const INCLUDE_EXT = new Set([
  ".html",
  ".js",
  ".css",
  ".png",
  ".svg",
  ".ico",
  ".webmanifest",
  ".woff",
  ".woff2",
  ".json",
]);

const SKIP_NAMES = new Set(["sw.js", "crypto-worker.js", "precache-manifest.json"]);

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, base, acc);
      continue;
    }
    if (SKIP_NAMES.has(name)) continue;
    const ext = path.extname(name).toLowerCase();
    if (!INCLUDE_EXT.has(ext)) continue;
    const rel = "/" + path.relative(base, full).split(path.sep).join("/");
    acc.push(rel);
  }
  return acc;
}

let entries;
try {
  entries = walk(outDir).sort();
} catch (err) {
  console.error(
    `build-sw-precache: expected static export at ${outDir} (run next build first)`,
  );
  throw err;
}

const outPath = path.join(outDir, "precache-manifest.json");
writeFileSync(outPath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
console.log(`build-sw-precache: wrote ${entries.length} urls → ${path.relative(root, outPath)}`);
