import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatFullTimestamp,
  formatHourDividerLabel,
  formatTokenCount,
  shouldShowHourDivider,
} from "./format";

describe("formatBytes", () => {
  it("renders sub-KB sizes in bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders KB/MB/GB with one decimal under 10 units, none at or above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("never throws on negative or non-finite input", () => {
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatTokenCount (UsageChip, W4.6)", () => {
  it("renders sub-1000 counts as plain numbers", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(4)).toBe("4");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("renders k/M with one decimal under 10 units, none at or above", () => {
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(10_000)).toBe("10k");
    expect(formatTokenCount(2_500_000)).toBe("2.5M");
  });

  it("never throws on negative or non-finite input", () => {
    expect(formatTokenCount(-5)).toBe("0");
    expect(formatTokenCount(Number.NaN)).toBe("0");
  });

  it("rolls over to the next unit instead of displaying a stale unit at 4 digits (rounding boundary)", () => {
    // toFixed(1) rounds 999.95 up to "1000.0" before the unit is chosen —
    // without a re-check after rounding this renders "1000.0k" instead of
    // rolling over to "1.0M". Mirrors the equivalent boundary in
    // `formatBytes` (same base-swap algorithm, see file header).
    expect(formatTokenCount(999_950)).toBe("1.0M");
    // Same class of bug one unit down: 9999 rounds to "10.0k" (1 decimal,
    // chosen while value was still <10) instead of "10k".
    expect(formatTokenCount(9999)).toBe("10k");
  });
});

// Local wall-clock formatting (`shouldShowHourDivider`/`formatHourDividerLabel`/
// `formatFullTimestamp`, plan-v2.md W4.2) is inherently timezone-dependent —
// pinned to UTC for this test file only, so assertions are deterministic
// regardless of the machine running them. Production code never sets `TZ`;
// the browser's real local timezone always applies there, which is the
// whole point of "hourly" dividers following the *viewer's* clock.
process.env.TZ = "UTC";

const HOUR = 60 * 60 * 1000;
// 2026-07-18T15:30:00.000Z
const T_1530 = Date.UTC(2026, 6, 18, 15, 30, 0);

describe("shouldShowHourDivider", () => {
  it("always shows for the very first item (no previous time)", () => {
    expect(shouldShowHourDivider(undefined, T_1530)).toBe(true);
  });

  it("stays hidden within the same local hour", () => {
    expect(shouldShowHourDivider(T_1530, T_1530 + 29 * 60 * 1000)).toBe(false);
  });

  it("shows once the local hour rolls over", () => {
    expect(shouldShowHourDivider(T_1530, T_1530 + HOUR)).toBe(true);
  });

  it("shows across a day boundary (still just an hour-bucket change)", () => {
    const lateNight = Date.UTC(2026, 6, 18, 23, 50, 0);
    const nextMorning = Date.UTC(2026, 6, 19, 0, 10, 0);
    expect(shouldShowHourDivider(lateNight, nextMorning)).toBe(true);
  });
});

describe("formatHourDividerLabel", () => {
  it("renders month, day, and rounded-down hour:minute", () => {
    expect(formatHourDividerLabel(T_1530)).toBe("Jul 18, 3:00 PM");
  });
});

describe("formatFullTimestamp", () => {
  it("renders a full date + time for the hover tooltip", () => {
    expect(formatFullTimestamp(T_1530)).toBe("Jul 18, 2026, 3:30:00 PM");
  });
});
