import { describe, expect, it } from "vitest";
import { expandEnvVars } from "./envExpand.js";

describe("expandEnvVars", () => {
  it("returns the template untouched when there is nothing to expand", () => {
    const result = expandEnvVars({ FOO: "bar" }, {});
    expect(result).toEqual({ ok: true, env: { FOO: "bar" } });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: these strings are shell-style variable references, not JS template literals
  it("expands a ${VAR} reference against the base env", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: test data for expandEnvVars
    const result = expandEnvVars({ URL: "${BASE_URL}/api" }, { BASE_URL: "https://example.com" });
    expect(result).toEqual({ ok: true, env: { URL: "https://example.com/api" } });
  });

  it("expands multiple references within one value", () => {
    const result = expandEnvVars(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: test data for expandEnvVars
      { GREETING: "${GREETING_PREFIX}, ${NAME}!" },
      { GREETING_PREFIX: "hello", NAME: "world" },
    );
    expect(result).toEqual({ ok: true, env: { GREETING: "hello, world!" } });
  });

  it("fails fast when a referenced variable is unresolved", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: test data for expandEnvVars
    const result = expandEnvVars({ URL: "${BASE_URL}/api" }, {});
    expect(result).toEqual({ ok: false, unresolved: ["BASE_URL"] });
  });

  it("collects every unresolved variable across all template entries, not just the first", () => {
    const result = expandEnvVars(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: test data for expandEnvVars
      { A: "${MISSING_A}", B: "${MISSING_B}/${MISSING_A}" },
      { OTHER: "x" },
    );
    expect(result).toEqual({ ok: false, unresolved: ["MISSING_A", "MISSING_B"] });
  });

  it("treats an empty-string env value as resolved (only undefined fails)", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: test data for expandEnvVars
    const result = expandEnvVars({ X: "[${EMPTY}]" }, { EMPTY: "" });
    expect(result).toEqual({ ok: true, env: { X: "[]" } });
  });

  it("leaves malformed placeholders (no closing brace, lowercase-invalid patterns aside) alone", () => {
    const result = expandEnvVars({ X: "$NOT_A_PLACEHOLDER" }, {});
    expect(result).toEqual({ ok: true, env: { X: "$NOT_A_PLACEHOLDER" } });
  });
});
