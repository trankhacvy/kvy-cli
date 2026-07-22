import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  commandNameFromRelativePath,
  type DirentLike,
  listSlashCommands,
  parseFrontMatter,
} from "./slashCommands.js";

function file(name: string): DirentLike {
  return { name, isDirectory: () => false, isFile: () => true };
}

function dir(name: string): DirentLike {
  return { name, isDirectory: () => true, isFile: () => false };
}

describe("parseFrontMatter", () => {
  it("returns {} for a file with no frontmatter block", () => {
    expect(parseFrontMatter("Just do the thing.\n")).toEqual({});
  });

  it("extracts description and argument-hint from a frontmatter block", () => {
    const source = [
      "---",
      "description: Create a commit",
      "argument-hint: [message]",
      "---",
      "",
      "Body.",
    ].join("\n");
    expect(parseFrontMatter(source)).toEqual({
      description: "Create a commit",
      argumentHint: "[message]",
    });
  });

  it("strips matching quotes around a value", () => {
    const source = ["---", 'description: "Quoted description"', "---"].join("\n");
    expect(parseFrontMatter(source)).toEqual({ description: "Quoted description" });
  });

  it("ignores unrelated frontmatter keys", () => {
    const source = ["---", "allowed-tools: Bash, Read", "model: opus", "---"].join("\n");
    expect(parseFrontMatter(source)).toEqual({});
  });

  it("returns {} when the closing --- is missing", () => {
    expect(parseFrontMatter("---\ndescription: unterminated\n")).toEqual({});
  });
});

describe("commandNameFromRelativePath", () => {
  it("strips the .md extension for a top-level command", () => {
    expect(commandNameFromRelativePath("compact.md")).toBe("compact");
  });

  it("joins subdirectories with : as a namespace prefix", () => {
    expect(commandNameFromRelativePath(path.join("git", "commit.md"))).toBe("git:commit");
  });

  it("supports nested namespaces", () => {
    expect(commandNameFromRelativePath(path.join("a", "b", "c.md"))).toBe("a:b:c");
  });
});

describe("listSlashCommands", () => {
  const PARAMS = { idempotencyKey: "idem-1", worktree: "/repo" };

  it("returns an empty list when .claude/commands doesn't exist", async () => {
    const readdir = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const result = await listSlashCommands(PARAMS, { readdir });
    expect(result).toEqual({ commands: [] });
  });

  it("lists top-level .md files, ignoring non-.md files", async () => {
    const readdir = vi.fn(async (dir: string) => {
      expect(dir).toBe(path.join("/repo", ".claude", "commands"));
      return [file("compact.md"), file("README.txt")];
    });
    const readFile = vi.fn(async () => "No frontmatter here.");
    const result = await listSlashCommands(PARAMS, { readdir, readFile });
    expect(result).toEqual({ commands: [{ name: "compact" }] });
  });

  it("recurses into subdirectories, namespacing by path", async () => {
    const readdir = vi.fn(async (dirPath: string) => {
      if (dirPath === path.join("/repo", ".claude", "commands")) {
        return [file("compact.md"), dir("git")];
      }
      if (dirPath === path.join("/repo", ".claude", "commands", "git")) {
        return [file("commit.md")];
      }
      return [];
    });
    const readFile = vi.fn(async () => "");
    const result = await listSlashCommands(PARAMS, { readdir, readFile });
    expect(result.commands.map((c) => c.name).sort()).toEqual(["compact", "git:commit"]);
  });

  it("attaches description/argument-hint parsed from each file's frontmatter", async () => {
    const readdir = vi.fn(async () => [file("review.md")]);
    const readFile = vi.fn(
      async () => "---\ndescription: Review the diff\nargument-hint: [pr-number]\n---\nBody.",
    );
    const result = await listSlashCommands(PARAMS, { readdir, readFile });
    expect(result.commands).toEqual([
      { name: "review", description: "Review the diff", argumentHint: "[pr-number]" },
    ]);
  });

  it("still lists a command by name when its file can't be read", async () => {
    const readdir = vi.fn(async () => [file("broken.md")]);
    const readFile = vi.fn(async () => {
      throw new Error("EACCES");
    });
    const result = await listSlashCommands(PARAMS, { readdir, readFile });
    expect(result.commands).toEqual([{ name: "broken" }]);
  });

  it("sorts commands by name", async () => {
    const readdir = vi.fn(async () => [file("zeta.md"), file("alpha.md")]);
    const readFile = vi.fn(async () => "");
    const result = await listSlashCommands(PARAMS, { readdir, readFile });
    expect(result.commands.map((c) => c.name)).toEqual(["alpha", "zeta"]);
  });

  it("never throws — a broken nested directory just yields fewer results", async () => {
    const readdir = vi.fn(async (dirPath: string) => {
      if (dirPath === path.join("/repo", ".claude", "commands"))
        return [dir("broken"), file("ok.md")];
      throw new Error("EACCES");
    });
    const readFile = vi.fn(async () => "");
    const result = await listSlashCommands(PARAMS, { readdir, readFile });
    expect(result.commands).toEqual([{ name: "ok" }]);
  });
});
