import { describe, expect, it } from "vitest";
import type { SlashCommand } from "@/features/slash-commands";
import {
  applySlashCommandSelection,
  clampSlashSelection,
  detectSlashQuery,
  filterSlashCommands,
  moveSlashSelection,
} from "./slash-command-state";

describe("detectSlashQuery", () => {
  it("returns the empty query for a bare leading slash", () => {
    expect(detectSlashQuery("/")).toBe("");
  });

  it("returns the in-progress query while typing a command name", () => {
    expect(detectSlashQuery("/comp")).toBe("comp");
    expect(detectSlashQuery("/git:comm")).toBe("git:comm");
  });

  it("returns null for plain text with no leading slash", () => {
    expect(detectSlashQuery("hello")).toBeNull();
    expect(detectSlashQuery("")).toBeNull();
  });

  it("returns null once a space appears anywhere (arguments have started, or it's mid-sentence)", () => {
    expect(detectSlashQuery("/compact ")).toBeNull();
    expect(detectSlashQuery("/compact now")).toBeNull();
    expect(detectSlashQuery("hello /world")).toBeNull();
  });

  it("returns null for a slash that isn't the first character", () => {
    expect(detectSlashQuery(" /compact")).toBeNull();
    expect(detectSlashQuery("a/compact")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  const commands: SlashCommand[] = [
    { name: "compact" },
    { name: "review" },
    { name: "git:commit" },
    { name: "git:pr" },
    { name: "recap" },
  ];

  it("returns every command for an empty query", () => {
    expect(filterSlashCommands(commands, "")).toEqual(commands);
  });

  it("ranks prefix matches before substring-elsewhere matches", () => {
    // "re" is a prefix of "review"/"recap" but only a substring of nothing
    // else here; "comp" is a prefix of "compact".
    const result = filterSlashCommands(commands, "re");
    expect(result.map((c) => c.name)).toEqual(["review", "recap"]);
  });

  it("matches a substring anywhere in the name, ranked after prefix matches", () => {
    // "commit" only appears mid-name in "git:commit" (no command whose name
    // itself starts with "commit").
    const result = filterSlashCommands(commands, "commit");
    expect(result.map((c) => c.name)).toEqual(["git:commit"]);
  });

  it("is case-insensitive", () => {
    expect(filterSlashCommands(commands, "COMP").map((c) => c.name)).toEqual(["compact"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterSlashCommands(commands, "zzz")).toEqual([]);
  });
});

describe("moveSlashSelection", () => {
  it("wraps forward past the last index back to 0", () => {
    expect(moveSlashSelection(2, 3, 1)).toBe(0);
  });

  it("wraps backward past 0 to the last index", () => {
    expect(moveSlashSelection(0, 3, -1)).toBe(2);
  });

  it("moves by one within range", () => {
    expect(moveSlashSelection(0, 3, 1)).toBe(1);
    expect(moveSlashSelection(1, 3, -1)).toBe(0);
  });

  it("stays at 0 when there's nothing to select", () => {
    expect(moveSlashSelection(0, 0, 1)).toBe(0);
    expect(moveSlashSelection(0, 0, -1)).toBe(0);
  });
});

describe("clampSlashSelection", () => {
  it("clamps an out-of-range index down to the last valid one", () => {
    expect(clampSlashSelection(5, 2)).toBe(1);
  });

  it("clamps a negative index up to 0", () => {
    expect(clampSlashSelection(-1, 2)).toBe(0);
  });

  it("stays at 0 when there's nothing to select", () => {
    expect(clampSlashSelection(3, 0)).toBe(0);
  });

  it("leaves an in-range index untouched", () => {
    expect(clampSlashSelection(1, 3)).toBe(1);
  });
});

describe("applySlashCommandSelection", () => {
  it("returns the full invocation name with a trailing space", () => {
    expect(applySlashCommandSelection({ name: "compact" })).toBe("/compact ");
    expect(applySlashCommandSelection({ name: "git:commit", description: "x" })).toBe(
      "/git:commit ",
    );
  });
});
