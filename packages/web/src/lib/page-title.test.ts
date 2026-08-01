import { describe, expect, it } from "vitest";
import { LANDING_DOCUMENT_TITLE, titleForPath } from "./page-title";

describe("titleForPath", () => {
  it("returns the landing SEO title for /", () => {
    expect(titleForPath("/")).toBe(LANDING_DOCUMENT_TITLE);
    expect(titleForPath("")).toBe(LANDING_DOCUMENT_TITLE);
  });

  it("returns route-specific titles for public pages", () => {
    expect(titleForPath("/signin/")).toBe("Sign in · Kvy");
    expect(titleForPath("/privacy")).toBe("Privacy · Kvy");
    expect(titleForPath("/terms/")).toBe("Terms · Kvy");
  });

  it("falls back to Kvy for app routes", () => {
    expect(titleForPath("/dashboard/")).toBe("Kvy");
    expect(titleForPath("/dashboard/session/abc/")).toBe("Kvy");
  });
});
