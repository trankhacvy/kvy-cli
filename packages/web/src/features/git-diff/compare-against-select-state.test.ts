import { describe, expect, it } from "vitest";
import {
  CUSTOM_VALUE,
  HEAD_VALUE,
  isSafeCompareRef,
  resolveCustomRefSubmit,
  resolveSelectChange,
  resolveSelectValue,
  WORKSPACE_DEFAULT_VALUE,
} from "./compare-against-select-state";

describe("isSafeCompareRef", () => {
  it("rejects an empty or whitespace-only ref", () => {
    expect(isSafeCompareRef("")).toBe(false);
    expect(isSafeCompareRef("   ")).toBe(false);
  });

  it("rejects a '-'-prefixed ref (could be parsed as a git diff option)", () => {
    expect(isSafeCompareRef("--output=/tmp/evil")).toBe(false);
    expect(isSafeCompareRef("-x")).toBe(false);
  });

  it("accepts an ordinary branch name, tag, or SHA", () => {
    expect(isSafeCompareRef("main")).toBe(true);
    expect(isSafeCompareRef("v1.2.3")).toBe(true);
    expect(isSafeCompareRef("abc1234")).toBe(true);
    expect(isSafeCompareRef(HEAD_VALUE)).toBe(true);
  });
});

describe("resolveSelectValue", () => {
  it("returns the custom sentinel while the custom field is open, regardless of compareRef", () => {
    expect(resolveSelectValue(null, true)).toBe(CUSTOM_VALUE);
    expect(resolveSelectValue("main", true)).toBe(CUSTOM_VALUE);
  });

  it("returns the workspace-default sentinel when compareRef is null and custom is closed", () => {
    expect(resolveSelectValue(null, false)).toBe(WORKSPACE_DEFAULT_VALUE);
  });

  it("returns compareRef itself (e.g. HEAD or a branch name) when set and custom is closed", () => {
    expect(resolveSelectValue(HEAD_VALUE, false)).toBe(HEAD_VALUE);
    expect(resolveSelectValue("release/1.0", false)).toBe("release/1.0");
  });
});

describe("resolveSelectChange", () => {
  it("opens the custom field when the custom sentinel is selected", () => {
    expect(resolveSelectChange(CUSTOM_VALUE)).toEqual({ openCustom: true });
  });

  it("maps the workspace-default sentinel to a null compareRef", () => {
    expect(resolveSelectChange(WORKSPACE_DEFAULT_VALUE)).toEqual({
      openCustom: false,
      ref: null,
    });
  });

  it("passes any other value (HEAD or a branch name) straight through as the new compareRef", () => {
    expect(resolveSelectChange(HEAD_VALUE)).toEqual({ openCustom: false, ref: HEAD_VALUE });
    expect(resolveSelectChange("release/1.0")).toEqual({
      openCustom: false,
      ref: "release/1.0",
    });
  });
});

describe("resolveCustomRefSubmit", () => {
  it("rejects an empty/whitespace-only custom ref", () => {
    expect(resolveCustomRefSubmit("")).toBeNull();
    expect(resolveCustomRefSubmit("   ")).toBeNull();
  });

  it("rejects a '-'-prefixed custom ref", () => {
    expect(resolveCustomRefSubmit("--output=/tmp/evil")).toBeNull();
    expect(resolveCustomRefSubmit("-x")).toBeNull();
  });

  it("accepts and trims a valid custom ref", () => {
    expect(resolveCustomRefSubmit("  release/1.0  ")).toBe("release/1.0");
    expect(resolveCustomRefSubmit("abc1234")).toBe("abc1234");
  });
});
