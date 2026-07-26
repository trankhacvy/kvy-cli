import { describe, expect, it } from "vitest";
import * as messages from "./messages.js";

/**
 * Exercises template functions as well as plain string exports — jargon is most
 * likely to creep into the interpolated ones.
 */
function allStrings(): string[] {
  const out: string[] = [];
  for (const value of Object.values(messages)) {
    if (typeof value === "string") {
      out.push(value);
      continue;
    }
    if (typeof value === "function") {
      const fn = value as (arg: string) => string;
      out.push(fn("sample@example.com"));
      out.push(fn("https://example.com/pair#abc"));
    }
  }
  return out;
}

describe("CLI auth copy", () => {
  it("never tells the user to run auth login, except with no terminal", () => {
    const offenders = allStrings().filter(
      (message) => /falcon auth login/.test(message) && !/no terminal here/.test(message),
    );
    expect(offenders).toEqual([]);
  });

  it("uses no internal jargon", () => {
    for (const message of allStrings()) {
      expect(message).not.toMatch(/masterSecret|keyEpoch|ephPub|DEK|custody|\bbind\b/i);
    }
  });

  it("keeps the substring commands/start.test.ts asserts on", () => {
    expect(messages.NO_TTY_CANNOT_SIGN_IN).toContain("not logged in");
  });

  it("renders an account email when one is known", () => {
    expect(messages.connectedAs("a@b.com")).toContain("a@b.com");
    expect(messages.connectedAs(null)).toContain("Connected");
  });
});
