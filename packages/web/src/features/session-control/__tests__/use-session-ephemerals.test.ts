import { describe, expect, it } from "vitest";
import { isWorkingFresh, WORKING_STALE_MS } from "../use-session-ephemerals.js";

describe("isWorkingFresh", () => {
  it("is false when no working:true has ever arrived", () => {
    expect(isWorkingFresh(null, 0)).toBe(false);
  });

  it("is true immediately after a working:true arrives", () => {
    expect(isWorkingFresh(1_000, 1_000)).toBe(true);
  });

  it("is true just under the staleness cap", () => {
    expect(isWorkingFresh(0, WORKING_STALE_MS - 1)).toBe(true);
  });

  it("is false once the staleness cap has elapsed with no successor", () => {
    expect(isWorkingFresh(0, WORKING_STALE_MS)).toBe(false);
  });

  it("is false well past the staleness cap", () => {
    expect(isWorkingFresh(0, WORKING_STALE_MS * 10)).toBe(false);
  });
});
