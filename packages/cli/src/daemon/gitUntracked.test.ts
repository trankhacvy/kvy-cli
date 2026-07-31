import { describe, expect, it } from "vitest";
import { listUntrackedFiles, parseUntrackedPath } from "./gitUntracked.js";

describe("parseUntrackedPath", () => {
  it("extracts the path from an untracked ('?') porcelain v2 line", () => {
    expect(parseUntrackedPath("? src/new.ts")).toBe("src/new.ts");
  });

  it("returns null for every other line shape", () => {
    expect(parseUntrackedPath("# branch.head main")).toBeNull();
    expect(parseUntrackedPath("1 M. N... 100644 100644 100644 aaaa bbbb src/a.ts")).toBeNull();
    expect(parseUntrackedPath("")).toBeNull();
  });
});

describe("listUntrackedFiles", () => {
  it("returns every untracked path from a fresh git status call", async () => {
    const output = ["# branch.oid abc123", "# branch.head main", "? a.txt", "? dir/b.txt", ""].join(
      "\n",
    );
    const git = async () => output;

    expect(await listUntrackedFiles("/repo", git)).toEqual(["a.txt", "dir/b.txt"]);
  });

  it("returns an empty array when nothing is untracked", async () => {
    const git = async () => ["# branch.oid abc123", "# branch.head main", ""].join("\n");

    expect(await listUntrackedFiles("/repo", git)).toEqual([]);
  });

  it("requests --untracked-files=all, so a whole untracked directory is never collapsed into one entry", async () => {
    let argsUsed: string[] | undefined;
    const git = async (args: string[]) => {
      argsUsed = args;
      return ["# branch.head main", "? dir/a.txt", "? dir/b.txt", ""].join("\n");
    };

    const paths = await listUntrackedFiles("/repo", git);

    expect(argsUsed).toContain("--untracked-files=all");
    expect(paths).toEqual(["dir/a.txt", "dir/b.txt"]);
  });
});
