import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./format-relative-time";

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-07-16T12:00:00Z");

  it("returns 'just now' for anything under a minute old", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("just now");
    expect(formatRelativeTime(now, now)).toBe("just now");
  });

  it("formats minutes, hours, and days", () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe("3h");
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe("2d");
  });

  it("never goes negative for a timestamp that is (clock-skew) in the future", () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe("just now");
  });
});
