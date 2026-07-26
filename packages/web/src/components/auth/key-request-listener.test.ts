import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `KeyRequestListener` can't be rendered directly under this package's `environment: "node"`
 * vitest config (no DOM) — same source-text technique used across this package for
 * similarly hook-heavy JSX.
 *
 * auth-ux-overhaul-fix-plan.md Fix 11: the second confirmed sub-fix, same shape as
 * `/pair/`'s Approve button — the send-keys button must never be able to look clickable
 * while `approve()` can't do anything.
 */
const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./key-request-listener.tsx"),
  "utf-8",
);

describe("key-request-listener.tsx — send-keys button disabled state (Fix 11)", () => {
  it("derives its disabled prop from both the pending flag and bridge presence", () => {
    expect(source).toContain("disabled={pending || !bridge}");
  });
});
