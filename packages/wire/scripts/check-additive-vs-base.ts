/**
 * CI lint: fails if any @kvy/wire schema that already existed on the base
 * branch has lost a field or had a field retyped in a way that violates
 * additive-only-forever (design §5.3 — "the server can never migrate
 * ciphertext... payload schemas are additive-only, forever").
 *
 * This complements `additiveOnly.test.ts` (which diffs live schemas against
 * the checked-in `wire-shapes.json` fixture) rather than replacing it: that
 * test only catches a breaking change if the fixture *isn't* also updated in
 * the same PR. A PR that both breaks a schema and regenerates the fixture to
 * match would pass that test cleanly. This script instead re-derives the
 * "before" state directly from git history — it checks out
 * `packages/wire/src` exactly as it existed on the base branch and
 * re-fingerprints it with *this* branch's `describeShape`/`isCompatible` — so
 * regenerating the fixture can never hide a breaking change; the comparison
 * point is always the real base branch, not whatever JSON happens to be on
 * disk.
 *
 * Usage: pnpm --filter @kvy/wire run lint:additive
 *
 * Base ref resolution (first one `git rev-parse` accepts, in order):
 *   1. $WIRE_LINT_BASE_REF        (explicit override)
 *   2. origin/$GITHUB_BASE_REF    (GitHub Actions pull_request context)
 *   3. origin/main
 *   4. main                       (local dev without a fetched origin)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { z } from "zod";
import { schemaRegistry as currentRegistry } from "../src/__tests__/schemaRegistry";
import { describeShape, isCompatible } from "../src/__tests__/schemaShape";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// packages/wire/scripts -> packages/wire -> packages -> <repo root>
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const WIRE_SRC = "packages/wire/src";

function candidateBaseRefs(): string[] {
  const candidates: string[] = [];
  if (process.env.WIRE_LINT_BASE_REF) candidates.push(process.env.WIRE_LINT_BASE_REF);
  if (process.env.GITHUB_BASE_REF) candidates.push(`origin/${process.env.GITHUB_BASE_REF}`);
  candidates.push("origin/main", "main");
  return candidates;
}

function resolveBaseRef(): string | undefined {
  for (const ref of candidateBaseRefs()) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return ref;
    } catch {
      // Not resolvable locally; try the next candidate.
    }
  }
  return undefined;
}

function baseRefHasWirePackage(ref: string): boolean {
  const listing = execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", WIRE_SRC], {
    cwd: REPO_ROOT,
  }).toString("utf8");
  return listing.trim().length > 0;
}

/**
 * Materializes `packages/wire/src` as it existed at `ref` into a throwaway
 * directory *inside* the repo (not the system tmpdir) — Node module
 * resolution for the bare `zod`/`@paralleldrive/cuid2` imports inside those
 * files needs to walk up to the repo's own `node_modules`, which only works
 * if the extracted tree lives somewhere under the repo root.
 */
async function loadBaseRegistry(ref: string): Promise<Record<string, z.ZodTypeAny> | undefined> {
  const archive = execFileSync("git", ["archive", ref, "--", WIRE_SRC], {
    cwd: REPO_ROOT,
    maxBuffer: 1024 * 1024 * 64,
  });
  const tmpDir = mkdtempSync(join(REPO_ROOT, "packages", "wire", ".wire-lint-"));
  try {
    execFileSync("tar", ["-x", "-C", tmpDir], { input: archive });
    const registryFile = join(tmpDir, WIRE_SRC, "__tests__", "schemaRegistry.ts");
    if (!existsSync(registryFile)) return undefined;
    const mod = (await import(pathToFileURL(registryFile).href)) as {
      schemaRegistry: Record<string, z.ZodTypeAny>;
    };
    return mod.schemaRegistry;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const baseRef = resolveBaseRef();
  if (!baseRef) {
    console.warn(
      "[wire-additive-lint] no base ref (origin/main or main) could be resolved locally — skipping. " +
        "CI fetches the base branch before running this script; see the workflow if this warning " +
        "appears there.",
    );
    return;
  }

  if (!baseRefHasWirePackage(baseRef)) {
    console.warn(
      `[wire-additive-lint] ${baseRef} has no ${WIRE_SRC} — nothing to compare against, skipping.`,
    );
    return;
  }

  const baseRegistry = await loadBaseRegistry(baseRef);
  if (!baseRegistry) {
    console.warn(
      `[wire-additive-lint] ${baseRef} predates the schema registry (__tests__/schemaRegistry.ts) — skipping.`,
    );
    return;
  }

  const violations: string[] = [];
  for (const [name, baseSchema] of Object.entries(baseRegistry)) {
    const liveSchema = (currentRegistry as Record<string, z.ZodTypeAny>)[name];
    if (!liveSchema) {
      violations.push(`"${name}" existed on ${baseRef} but has been removed from the registry.`);
      continue;
    }
    const prevShape = describeShape(baseSchema);
    const nextShape = describeShape(liveSchema);
    if (!isCompatible(prevShape, nextShape)) {
      violations.push(`"${name}" lost or retyped a field that already shipped on ${baseRef}.`);
    }
  }

  if (violations.length > 0) {
    console.error(
      `[wire-additive-lint] FAILED — non-additive change(s) to @kvy/wire vs ${baseRef}:\n`,
    );
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\nEncrypted payload schemas are additive-only, forever (design §5.3): the server can " +
        "never migrate ciphertext, so every historical client must still be able to decode every " +
        "field it ever shipped. Add a new field (or a new versioned schema) instead of altering " +
        "or removing an existing one.",
    );
    process.exitCode = 1;
    return;
  }

  console.error(
    `[wire-additive-lint] OK — @kvy/wire is additive-only vs ${baseRef} ` +
      `(${Object.keys(baseRegistry).length} schema(s) checked).`,
  );
}

main().catch((err: unknown) => {
  console.error("[wire-additive-lint] unexpected error:", err);
  process.exitCode = 1;
});
