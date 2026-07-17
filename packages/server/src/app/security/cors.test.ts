import { describe, expect, it } from "vitest";
import { buildCorsOriginValidator } from "./cors.js";

function check(
  validator: ReturnType<typeof buildCorsOriginValidator>,
  origin: string | undefined,
): Promise<{ err: Error | null; allow: boolean | undefined }> {
  return new Promise((resolve) => {
    validator(origin, (err, allow) => resolve({ err, allow }));
  });
}

describe("buildCorsOriginValidator", () => {
  it("allows an exact allowlisted origin", async () => {
    const validator = buildCorsOriginValidator(["https://app.falcon.dev"]);
    const result = await check(validator, "https://app.falcon.dev");
    expect(result).toEqual({ err: null, allow: true });
  });

  it("rejects an origin not on the allowlist", async () => {
    const validator = buildCorsOriginValidator(["https://app.falcon.dev"]);
    const result = await check(validator, "https://evil.example");
    expect(result).toEqual({ err: null, allow: false });
  });

  it("rejects a wildcard-style spoof attempt (no substring/subdomain matching)", async () => {
    const validator = buildCorsOriginValidator(["https://app.falcon.dev"]);
    const result = await check(validator, "https://app.falcon.dev.evil.example");
    expect(result).toEqual({ err: null, allow: false });
  });

  it("allows requests with no Origin header (non-browser clients)", async () => {
    const validator = buildCorsOriginValidator(["https://app.falcon.dev"]);
    const result = await check(validator, undefined);
    expect(result).toEqual({ err: null, allow: true });
  });

  it("supports multiple allowlisted origins", async () => {
    const validator = buildCorsOriginValidator(["https://app.falcon.dev", "http://localhost:3000"]);
    expect(await check(validator, "http://localhost:3000")).toEqual({ err: null, allow: true });
    expect(await check(validator, "https://app.falcon.dev")).toEqual({ err: null, allow: true });
    expect(await check(validator, "http://localhost:4000")).toEqual({ err: null, allow: false });
  });
});
