import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Source-text technique: `KeyRequestListener` is hook-heavy and can't render under
// `environment: "node"` vitest config.
const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./key-request-listener.tsx"),
  "utf-8",
);

describe("key-request-listener.tsx — send-keys button disabled state", () => {
  it("derives its disabled prop from both the pending flag and bridge presence", () => {
    expect(source).toContain("disabled={pending || !bridge}");
  });
});
