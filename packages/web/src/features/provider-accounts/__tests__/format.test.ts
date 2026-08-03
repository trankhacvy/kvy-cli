import { describe, expect, it } from "vitest";
import {
  formatAuthType,
  formatBillingType,
  formatDateTime,
  formatLastRefreshed,
  formatUsageMeterLabel,
} from "../format";

describe("formatDateTime", () => {
  it("formats a timestamp as 'Mon D, H:MM AM/PM'", () => {
    // Just assert the shape (locale- and CI-timezone-formatted, so the exact
    // wording can vary) rather than the literal "Aug 18, 11:29 AM" string.
    expect(formatDateTime(Date.parse("2026-08-18T00:00:00Z"))).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/,
    );
  });
});

describe("formatUsageMeterLabel", () => {
  it("renders '<percent>% used · Resets <date>'", () => {
    const label = formatUsageMeterLabel({
      label: "Weekly",
      percentUsed: 93,
      resetsAt: "2026-07-20T18:00:00.000Z",
    });
    expect(label).toMatch(/^93% used · Resets /);
  });

  it("rounds a non-integer percent", () => {
    const label = formatUsageMeterLabel({
      label: "Weekly",
      percentUsed: 92.6,
      resetsAt: "2026-07-20T18:00:00.000Z",
    });
    expect(label.startsWith("93% used")).toBe(true);
  });

  it("falls back to 'resets unknown' for an unparseable resetsAt rather than throwing", () => {
    const label = formatUsageMeterLabel({
      label: "Weekly",
      percentUsed: 50,
      resetsAt: "not-a-date",
    });
    expect(label).toBe("50% used · resets unknown");
  });
});

describe("formatLastRefreshed", () => {
  it("renders 'Last refreshed <date>' for a known timestamp", () => {
    expect(formatLastRefreshed(Date.parse("2026-07-20T18:00:00.000Z"))).toMatch(/^Last refreshed /);
  });

  it("is honest about a missing timestamp instead of fabricating one", () => {
    expect(formatLastRefreshed(undefined)).toBe("Last refreshed time unknown");
  });
});

describe("formatAuthType", () => {
  it("maps known auth types to human labels", () => {
    expect(formatAuthType("oauth")).toBe("OAuth");
    expect(formatAuthType("api-key")).toBe("API key");
    expect(formatAuthType("chatgpt")).toBe("ChatGPT sign-in");
  });

  it("title-cases an unrecognized auth type instead of dumping the raw value", () => {
    expect(formatAuthType("some_new_mode")).toBe("Some New Mode");
  });

  it("reads 'Unknown' when absent", () => {
    expect(formatAuthType(undefined)).toBe("Unknown");
  });
});

describe("formatBillingType", () => {
  it("maps known billing types to human labels", () => {
    expect(formatBillingType("stripe_subscription")).toBe("Stripe Subscription");
    expect(formatBillingType("free")).toBe("Free");
  });

  it("title-cases an unrecognized billing type instead of dumping the raw value", () => {
    expect(formatBillingType("some-new-plan")).toBe("Some New Plan");
  });

  it("returns null (not a fabricated default) when absent", () => {
    expect(formatBillingType(undefined)).toBeNull();
  });
});
