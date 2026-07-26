import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression test for auth-ux-overhaul-fix-plan.md Fix 2: `build-worker.mjs`'s
 * `?? ""` used to defeat `lib/config.ts`'s own `?? "http://localhost:3005"` fallback
 * (`??` triggers on `undefined`, not on an empty string), so an unset `NEXT_PUBLIC_API_URL`
 * baked the worker's `API_URL` as `""` — every worker-side `fetch` became a same-origin
 * relative URL against the WEB origin, 404ing and silently signing every user out on
 * reload (auth-ux-overhaul-e2e-results.md E2E-4.1/6.1).
 *
 * Runs the real script as a subprocess (not an in-process import) because top-level
 * `await build(...)` executes once at module load — a second `import` of the same
 * specifier would hit Node's module cache and never re-run with a different env.
 */
const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.resolve(scriptsDir, "..");
const scriptPath = path.join(scriptsDir, "build-worker.mjs");
const outputPath = path.join(webRoot, "public/crypto-worker.js");
const scriptSource = readFileSync(scriptPath, "utf8");

function runBuild(env: Record<string, string | undefined>): string {
  execFileSync("node", [scriptPath], {
    cwd: webRoot,
    env: Object.fromEntries(
      Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });
  return readFileSync(outputPath, "utf8");
}

describe("build-worker.mjs", () => {
  let originalOutput: string | null = null;

  beforeAll(() => {
    originalOutput = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;
  });

  afterAll(() => {
    // `public/crypto-worker.js` is the same gitignored file `pnpm --filter @falcon/web dev`
    // rebuilds on every start — restoring its pre-test content just avoids leaving a
    // test-run artefact behind for a dev server that happens to be running concurrently.
    if (originalOutput !== null) {
      runBuild({});
    }
  });

  it("inlines the default API base when NEXT_PUBLIC_API_URL is unset, matching lib/config.ts's fallback", () => {
    const emitted = runBuild({ NEXT_PUBLIC_API_URL: undefined });
    expect(emitted).toContain(JSON.stringify("http://localhost:3005"));
  });

  it("inlines an explicitly-set NEXT_PUBLIC_API_URL verbatim", () => {
    const emitted = runBuild({ NEXT_PUBLIC_API_URL: "https://api.falcon.dev" });
    expect(emitted).toContain(JSON.stringify("https://api.falcon.dev"));
  });

  it("treats an explicit empty string the same as unset, not as a literal empty API base", () => {
    // `""` is falsy in the script's `process.env.NEXT_PUBLIC_API_URL ? ... : {}` check, so
    // it takes the same path as no var at all, rather than baking `API_URL` as `""` — the
    // exact defect this fix removes.
    const emitted = runBuild({ NEXT_PUBLIC_API_URL: "" });
    expect(emitted).toContain(JSON.stringify("http://localhost:3005"));
  });

  it("asserts the emitted bundle inlines the expected API base before letting the build succeed", () => {
    // Behavioural coverage of "the build fails loudly on a mismatch" needs corrupting the
    // script mid-run, which isn't worth the fragility — pin that the guard exists and is an
    // exact-string check on the expected base (the fix plan explicitly rejected a regex
    // alternative that would pass on ANY absolute-URL literal anywhere in the bundle).
    expect(scriptSource).toContain("expectedBase");
    expect(scriptSource).toContain("emitted.includes(JSON.stringify(expectedBase))");
    expect(scriptSource).toContain("throw new Error(");
  });
});
