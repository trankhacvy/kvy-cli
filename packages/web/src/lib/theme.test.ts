import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, parseTheme, toggleTheme } from "./theme";

describe("parseTheme", () => {
  it("accepts 'light'", () => {
    expect(parseTheme("light")).toBe("light");
  });

  it("accepts 'dark'", () => {
    expect(parseTheme("dark")).toBe("dark");
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

describe("toggleTheme", () => {
  it("flips dark to light", () => {
    expect(toggleTheme("dark")).toBe("light");
  });

  it("flips light to dark", () => {
    expect(toggleTheme("light")).toBe("dark");
  });
});
