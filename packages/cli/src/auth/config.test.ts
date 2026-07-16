import { describe, expect, it } from "vitest";
import { resolveBackendUrl, resolveFrontendUrl } from "./config.js";

describe("resolveBackendUrl", () => {
  it("defaults to the production API host", () => {
    expect(resolveBackendUrl({})).toBe("https://api.falcon.dev");
  });

  it("uses FALCON_BACKEND_URL when set", () => {
    expect(resolveBackendUrl({ FALCON_BACKEND_URL: "http://localhost:3005" })).toBe(
      "http://localhost:3005",
    );
  });

  it("strips a trailing slash", () => {
    expect(resolveBackendUrl({ FALCON_BACKEND_URL: "http://localhost:3005/" })).toBe(
      "http://localhost:3005",
    );
  });

  it("ignores a blank override", () => {
    expect(resolveBackendUrl({ FALCON_BACKEND_URL: "   " })).toBe("https://api.falcon.dev");
  });
});

describe("resolveFrontendUrl", () => {
  it("defaults to the production web host", () => {
    expect(resolveFrontendUrl({})).toBe("https://app.falcon.dev");
  });

  it("uses FALCON_FRONTEND_URL when set", () => {
    expect(resolveFrontendUrl({ FALCON_FRONTEND_URL: "http://localhost:3000/" })).toBe(
      "http://localhost:3000",
    );
  });
});
