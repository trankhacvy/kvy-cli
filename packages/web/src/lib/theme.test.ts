import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, parseTheme, resolveTheme } from "./theme";

describe("parseTheme", () => {
  it("accepts 'light'", () => {
    expect(parseTheme("light")).toBe("light");
  });

  it("accepts 'dark'", () => {
    expect(parseTheme("dark")).toBe("dark");
  });

  it("accepts 'system'", () => {
    expect(parseTheme("system")).toBe("system");
  });

  it("falls back to the default for null (no stored preference)", () => {
    expect(parseTheme(null)).toBe(DEFAULT_THEME);
  });

  it("falls back to the default for undefined", () => {
    expect(parseTheme(undefined)).toBe(DEFAULT_THEME);
  });

  it("falls back to the default for a foreign/stale value", () => {
    expect(parseTheme("solarized")).toBe(DEFAULT_THEME);
  });
});

describe("resolveTheme", () => {
  it("returns light/dark unchanged", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("falls back to dark for 'system' when matchMedia is unavailable", () => {
    expect(resolveTheme("system")).toBe("dark");
  });
});
