import { describe, expect, it } from "vitest";
import { resolveBackendUrl, resolveFrontendUrl } from "./config.js";

describe("resolveBackendUrl", () => {
  it("defaults to the production API host", () => {
    expect(resolveBackendUrl({})).toBe("https://api.kvy.dev");
  });

  it("uses KVY_BACKEND_URL when set", () => {
    expect(resolveBackendUrl({ KVY_BACKEND_URL: "http://localhost:3005" })).toBe(
      "http://localhost:3005",
    );
  });

  it("strips a trailing slash", () => {
    expect(resolveBackendUrl({ KVY_BACKEND_URL: "http://localhost:3005/" })).toBe(
      "http://localhost:3005",
    );
  });

  it("ignores a blank override", () => {
    expect(resolveBackendUrl({ KVY_BACKEND_URL: "   " })).toBe("https://api.kvy.dev");
  });
});

describe("resolveFrontendUrl", () => {
  it("defaults to the production web host", () => {
    expect(resolveFrontendUrl({})).toBe("https://app.kvy.dev");
  });

  it("uses KVY_FRONTEND_URL when set", () => {
    expect(resolveFrontendUrl({ KVY_FRONTEND_URL: "http://localhost:3000/" })).toBe(
      "http://localhost:3000",
    );
  });
});
