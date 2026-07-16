import { describe, expect, it } from "vitest";
import {
  asRecord,
  parseBashArgs,
  parseBashOutput,
  parseEditArgs,
  parseGrepGlobArgs,
  parseReadArgs,
  parseTodoItems,
  readNumber,
  readString,
} from "./tool-args";

describe("asRecord", () => {
  it("accepts plain objects", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("rejects arrays, null, and primitives", () => {
    expect(asRecord([1, 2])).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord("x")).toBeUndefined();
    expect(asRecord(42)).toBeUndefined();
    expect(asRecord(undefined)).toBeUndefined();
  });
});

describe("readString / readNumber", () => {
  it("reads a field of the matching type and ignores mismatched types", () => {
    const r = { name: "bash", count: 3 };
    expect(readString(r, "name")).toBe("bash");
    expect(readString(r, "count")).toBeUndefined();
    expect(readNumber(r, "count")).toBe(3);
    expect(readNumber(r, "name")).toBeUndefined();
  });

  it("degrades to undefined rather than throwing on an undefined record", () => {
    expect(readString(undefined, "name")).toBeUndefined();
  });
});

describe("parseBashArgs / parseBashOutput", () => {
  it("reads command, description, and timeout", () => {
    expect(parseBashArgs({ command: "ls -la", description: "list", timeout: 5000 })).toEqual({
      command: "ls -la",
      description: "list",
      timeout: 5000,
    });
  });

  it("degrades gracefully on a non-object args value", () => {
    expect(parseBashArgs("not an object")).toEqual({
      command: undefined,
      description: undefined,
      timeout: undefined,
    });
  });

  it("reads stdout/stderr from output", () => {
    expect(parseBashOutput({ stdout: "ok\n", stderr: "" })).toEqual({ stdout: "ok\n", stderr: "" });
  });
});

describe("parseEditArgs", () => {
  it("reads a single-edit shape", () => {
    const result = parseEditArgs({
      file_path: "a.ts",
      old_string: "foo",
      new_string: "bar",
    });
    expect(result.filePath).toBe("a.ts");
    expect(result.oldString).toBe("foo");
    expect(result.newString).toBe("bar");
    expect(result.edits).toBeUndefined();
  });

  it("reads a MultiEdit-style edits array, skipping malformed entries", () => {
    const result = parseEditArgs({
      file_path: "b.ts",
      edits: [
        { old_string: "1", new_string: "2" },
        "not-an-object",
        { old_string: "3", new_string: "4" },
      ],
    });
    expect(result.filePath).toBe("b.ts");
    expect(result.edits).toEqual([
      { oldString: "1", newString: "2" },
      { oldString: "3", newString: "4" },
    ]);
  });

  it("reads a Write-style content field", () => {
    const result = parseEditArgs({ file_path: "c.txt", content: "hello" });
    expect(result.content).toBe("hello");
  });
});

describe("parseReadArgs", () => {
  it("reads file_path/offset/limit", () => {
    expect(parseReadArgs({ file_path: "x.ts", offset: 10, limit: 50 })).toEqual({
      filePath: "x.ts",
      offset: 10,
      limit: 50,
    });
  });
});

describe("parseGrepGlobArgs", () => {
  it("reads pattern/path/glob", () => {
    expect(parseGrepGlobArgs({ pattern: "TODO", path: "src", glob: "*.ts" })).toEqual({
      pattern: "TODO",
      path: "src",
      glob: "*.ts",
    });
  });
});

describe("parseTodoItems", () => {
  it("reads a todos array", () => {
    const todos = parseTodoItems({
      todos: [
        { content: "write tests", status: "completed", activeForm: "Writing tests" },
        { content: "ship it", status: "pending" },
      ],
    });
    expect(todos).toEqual([
      { content: "write tests", status: "completed", activeForm: "Writing tests" },
      { content: "ship it", status: "pending", activeForm: undefined },
    ]);
  });

  it("returns an empty array rather than throwing when todos is missing", () => {
    expect(parseTodoItems({})).toEqual([]);
    expect(parseTodoItems(undefined)).toEqual([]);
  });
});
