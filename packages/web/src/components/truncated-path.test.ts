import { describe, expect, it } from "vitest";
import { splitPathTail } from "./truncated-path";

describe("splitPathTail", () => {
  it("splits a normal absolute path into head + tail", () => {
    expect(splitPathTail("/Users/trankhacvy/conductor/workspaces/vientiane/packages/cli")).toEqual({
      head: "/Users/trankhacvy/conductor/workspaces/vientiane/packages/",
      tail: "cli",
    });
  });

  it("strips a trailing slash before splitting", () => {
    expect(splitPathTail("/Users/trankhacvy/project/")).toEqual({
      head: "/Users/trankhacvy/",
      tail: "project",
    });
  });

  it("handles Windows-style backslash separators", () => {
    expect(splitPathTail("C:\\Users\\trankhacvy\\project")).toEqual({
      head: "C:\\Users\\trankhacvy\\",
      tail: "project",
    });
  });

  it("falls back to an empty head for a value with no separator", () => {
    expect(splitPathTail("project")).toEqual({ head: "", tail: "project" });
  });

  it("falls back to the original value as tail for a bare root", () => {
    expect(splitPathTail("/")).toEqual({ head: "", tail: "/" });
  });
});
