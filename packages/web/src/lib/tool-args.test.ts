import { describe, expect, it } from "vitest";
import {
  asRecord,
  isAskUserQuestion,
  parseAskAnswers,
  parseAskQuestions,
  parseBashArgs,
  parseBashOutput,
  parseEditArgs,
  parseExitPlanModeArgs,
  parseGrepGlobArgs,
  parseLsArgs,
  parseNotebookEditArgs,
  parseReadArgs,
  parseTaskCreateArgs,
  parseTaskUpdateArgs,
  parseTodoItems,
  parseWebFetchArgs,
  parseWebSearchArgs,
  parseWebSearchResults,
  readNumber,
  readString,
  readStringArray,
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

describe("readStringArray", () => {
  it("reads a string array and drops non-string entries", () => {
    expect(readStringArray({ ignore: ["a", 1, "b"] }, "ignore")).toEqual(["a", "b"]);
  });

  it("returns undefined for a missing or empty array", () => {
    expect(readStringArray({}, "ignore")).toBeUndefined();
    expect(readStringArray({ ignore: [] }, "ignore")).toBeUndefined();
    expect(readStringArray({ ignore: "not-an-array" }, "ignore")).toBeUndefined();
  });
});

describe("parseWebFetchArgs", () => {
  it("reads url and prompt", () => {
    expect(parseWebFetchArgs({ url: "https://example.com", prompt: "summarize" })).toEqual({
      url: "https://example.com",
      prompt: "summarize",
    });
  });

  it("degrades gracefully on a non-object args value", () => {
    expect(parseWebFetchArgs(undefined)).toEqual({ url: undefined, prompt: undefined });
  });
});

describe("parseWebSearchArgs", () => {
  it("reads query and domain filters", () => {
    expect(
      parseWebSearchArgs({
        query: "typescript 5.6",
        allowed_domains: ["microsoft.com"],
        blocked_domains: ["spam.example"],
      }),
    ).toEqual({
      query: "typescript 5.6",
      allowedDomains: ["microsoft.com"],
      blockedDomains: ["spam.example"],
    });
  });

  it("degrades gracefully on a non-object args value", () => {
    expect(parseWebSearchArgs("not an object")).toEqual({
      query: undefined,
      allowedDomains: undefined,
      blockedDomains: undefined,
    });
  });
});

describe("parseWebSearchResults", () => {
  // Real shape from a Claude Code WebSearch tool-result (verified against
  // `packages/cli/src/claude/__fixtures__/task_non_sdk.jsonl`): a text blob
  // with an embedded `Links: [...]` JSON array, not structured JSON at the
  // top level.
  it("extracts the embedded Links array from a real tool-result text blob", () => {
    const output =
      'Web search results for query: "typescript 5.6"\n\n' +
      "I'll search for information.\n\n" +
      'Links: [{"title":"Announcing TypeScript 5.6","url":"https://devblogs.microsoft.com/typescript/announcing-typescript-5-6/"},{"title":"Releases","url":"https://github.com/microsoft/typescript/releases"}]\n\n' +
      "Based on the search results...";

    expect(parseWebSearchResults(output)).toEqual([
      {
        title: "Announcing TypeScript 5.6",
        url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-6/",
      },
      { title: "Releases", url: "https://github.com/microsoft/typescript/releases" },
    ]);
  });

  it("returns undefined when there is no embedded Links array, a non-array Links value, or non-string output", () => {
    expect(parseWebSearchResults("no results found")).toBeUndefined();
    expect(parseWebSearchResults("Links: {}")).toBeUndefined();
    expect(parseWebSearchResults({ results: [] })).toBeUndefined();
    expect(parseWebSearchResults(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty Links array or entries with neither title nor url", () => {
    expect(parseWebSearchResults("Links: []")).toBeUndefined();
    expect(parseWebSearchResults('Links: [{}, {"other":true}]')).toBeUndefined();
  });

  it("returns undefined rather than throwing on malformed embedded JSON", () => {
    expect(parseWebSearchResults('Links: [{"title": "unterminated]')).toBeUndefined();
  });
});

describe("parseNotebookEditArgs", () => {
  it("reads notebook_path/cell_id/new_source/cell_type/edit_mode", () => {
    expect(
      parseNotebookEditArgs({
        notebook_path: "nb.ipynb",
        cell_id: "cell-1",
        new_source: "print('hi')",
        cell_type: "code",
        edit_mode: "insert",
      }),
    ).toEqual({
      notebookPath: "nb.ipynb",
      cellId: "cell-1",
      newSource: "print('hi')",
      cellType: "code",
      editMode: "insert",
    });
  });

  it("degrades gracefully on a non-object args value", () => {
    expect(parseNotebookEditArgs(undefined)).toEqual({
      notebookPath: undefined,
      cellId: undefined,
      newSource: undefined,
      cellType: undefined,
      editMode: undefined,
    });
  });
});

describe("parseExitPlanModeArgs", () => {
  it("reads the plan string", () => {
    expect(parseExitPlanModeArgs({ plan: "# Step 1\n\nDo the thing." })).toEqual({
      plan: "# Step 1\n\nDo the thing.",
    });
  });

  it("degrades to undefined when plan is missing", () => {
    expect(parseExitPlanModeArgs({})).toEqual({ plan: undefined });
  });

  it("degrades to undefined when plan is not a string", () => {
    expect(parseExitPlanModeArgs({ plan: 12345 })).toEqual({ plan: undefined });
  });

  it("degrades gracefully on a non-object args value", () => {
    expect(parseExitPlanModeArgs(undefined)).toEqual({ plan: undefined });
    expect(parseExitPlanModeArgs("not an object")).toEqual({ plan: undefined });
    expect(parseExitPlanModeArgs(null)).toEqual({ plan: undefined });
    expect(parseExitPlanModeArgs(["not", "an", "object"])).toEqual({ plan: undefined });
  });
});

describe("parseLsArgs", () => {
  it("reads path and ignore", () => {
    expect(parseLsArgs({ path: "/tmp/proj", ignore: ["*.log"] })).toEqual({
      path: "/tmp/proj",
      ignore: ["*.log"],
    });
  });

  it("degrades gracefully on a non-object args value", () => {
    expect(parseLsArgs("not an object")).toEqual({ path: undefined, ignore: undefined });
  });
});

describe("isAskUserQuestion", () => {
  it("matches both tool-name spellings and nothing else", () => {
    expect(isAskUserQuestion("AskUserQuestion")).toBe(true);
    expect(isAskUserQuestion("ask_user_question")).toBe(true);
    expect(isAskUserQuestion("Bash")).toBe(false);
  });
});

describe("parseAskQuestions", () => {
  it("reads a single-select question with string options", () => {
    const questions = parseAskQuestions({
      questions: [{ question: "Which color?", header: "Color", options: ["Red", "Blue"] }],
    });
    expect(questions).toEqual([
      {
        question: "Which color?",
        header: "Color",
        multiSelect: undefined,
        options: [
          { label: "Red", description: undefined },
          { label: "Blue", description: undefined },
        ],
      },
    ]);
  });

  it("reads a multiSelect question with object options + descriptions", () => {
    const questions = parseAskQuestions({
      questions: [
        {
          question: "Which frameworks?",
          multiSelect: true,
          options: [{ label: "React", description: "UI library" }, { label: "Vue" }],
        },
      ],
    });
    expect(questions[0]?.multiSelect).toBe(true);
    expect(questions[0]?.options).toEqual([
      { label: "React", description: "UI library" },
      { label: "Vue", description: undefined },
    ]);
  });

  it("reads a multi-question form, preserving order", () => {
    const questions = parseAskQuestions({
      questions: [
        { question: "Q1", options: ["A"] },
        { question: "Q2", options: ["B"] },
      ],
    });
    expect(questions.map((q) => q.question)).toEqual(["Q1", "Q2"]);
  });

  it("reads a top-level single-question shape used by some CLI/tool paths", () => {
    const questions = parseAskQuestions({
      question: "Which approach should I take?",
      options: ["A", "B"],
    });
    expect(questions).toEqual([
      {
        question: "Which approach should I take?",
        header: undefined,
        multiSelect: undefined,
        options: [
          { label: "A", description: undefined },
          { label: "B", description: undefined },
        ],
      },
    ]);
  });

  it("drops malformed questions/options rather than throwing", () => {
    expect(
      parseAskQuestions({
        questions: [{ question: "Q1", options: ["A", 42, { noLabel: true }] }, "not-an-object", {}],
      }),
    ).toEqual([
      {
        question: "Q1",
        header: undefined,
        multiSelect: undefined,
        options: [{ label: "A", description: undefined }],
      },
    ]);
  });

  it("returns an empty array rather than throwing when questions is missing", () => {
    expect(parseAskQuestions({})).toEqual([]);
    expect(parseAskQuestions(undefined)).toEqual([]);
  });
});

describe("parseAskAnswers", () => {
  // Real Claude Code 2.1.218 tool_result `content` strings, captured from a
  // live `falcon claude` session (docs/known-issues.md issue #5 track B) —
  // not hand-guessed. Both a single- and a two-question call use this exact
  // `"question"="answer"` shape.
  it("parses a real single-question tool_result string", () => {
    expect(
      parseAskAnswers(
        'Your questions have been answered: "Which color do you prefer?"="Blue". You can now continue with these answers in mind.',
      ),
    ).toEqual([{ question: "Which color do you prefer?", answer: "Blue" }]);
  });

  it("parses a real multi-question tool_result string, in order", () => {
    expect(
      parseAskAnswers(
        'Your questions have been answered: "Which color do you prefer?"="Red", "Which size?"="Small". You can now continue with these answers in mind.',
      ),
    ).toEqual([
      { question: "Which color do you prefer?", answer: "Red" },
      { question: "Which size?", answer: "Small" },
    ]);
  });

  it("parses an answer containing a comma without mis-splitting on it", () => {
    expect(
      parseAskAnswers('Your questions have been answered: "Drink?"="Yes, please".'),
    ).toEqual([{ question: "Drink?", answer: "Yes, please" }]);
  });

  // A free-text "Type something" answer (verified live, same session) uses a
  // DIFFERENT surrounding template than a picked-option answer — "The user
  // answered: ..." rather than "Your questions have been answered: ..." —
  // but the same `"question"="answer"` pair shape. The regex scans for pairs
  // anywhere in the string rather than anchoring to either exact sentence,
  // so both variants parse identically without special-casing which one it is.
  it("parses a real free-text ('Type something') answer, despite its different wrapper sentence", () => {
    expect(
      parseAskAnswers(
        'The user answered: "What is your favorite drink?"="Hot chocolate". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.',
      ),
    ).toEqual([{ question: "What is your favorite drink?", answer: "Hot chocolate" }]);
  });

  it("does not mistake a real declined tool_result string for an answer", () => {
    // Claude Code's own synthetic decline text (verified live) — no
    // `"..."="..."` pair anywhere in it, so this must stay undefined and let
    // the card's own `isDeclinedQuestion` heuristic (AskUserQuestionToolCard.tsx)
    // handle it instead.
    expect(
      parseAskAnswers(
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
      ),
    ).toBeUndefined();
  });

  it("reads an {answers: {question: answer}} map", () => {
    expect(parseAskAnswers({ answers: { "Which color?": "Blue" } })).toEqual([
      { question: "Which color?", answer: "Blue" },
    ]);
  });

  it("reads an array of {question, answer} entries", () => {
    expect(parseAskAnswers([{ question: "Q1", answer: "A1" }])).toEqual([
      { question: "Q1", answer: "A1" },
    ]);
  });

  it("returns undefined on an unrecognized shape rather than throwing", () => {
    expect(parseAskAnswers({ nothingUseful: true })).toBeUndefined();
    expect(parseAskAnswers("raw string")).toBeUndefined();
    expect(parseAskAnswers(undefined)).toBeUndefined();
  });
});

// Real shapes below are taken verbatim from a captured live transcript
// (`packages/cli/src/claude/__fixtures__/task-create-update-session.jsonl`,
// bug-fix-plan.md #7) — every `TaskCreate` call in that session creates
// exactly one task with this args shape.
describe("parseTaskCreateArgs", () => {
  it("reads subject/description/activeForm from a real TaskCreate call", () => {
    expect(
      parseTaskCreateArgs({
        subject: "Prune merged workflow worktrees and branches",
        description:
          "Remove .worktrees/* entries whose branches are fully merged into main (P0/P1/P17 land + task worktrees). Only delete worktrees with clean trees and merged branches.",
        activeForm: "Pruning merged worktrees",
      }),
    ).toEqual({
      subject: "Prune merged workflow worktrees and branches",
      description:
        "Remove .worktrees/* entries whose branches are fully merged into main (P0/P1/P17 land + task worktrees). Only delete worktrees with clean trees and merged branches.",
      activeForm: "Pruning merged worktrees",
    });
  });

  it("degrades to undefined fields when args has none of the expected keys", () => {
    expect(parseTaskCreateArgs({})).toEqual({
      subject: undefined,
      description: undefined,
      activeForm: undefined,
    });
  });

  it("degrades gracefully on a non-object args value", () => {
    expect(parseTaskCreateArgs(undefined)).toEqual({
      subject: undefined,
      description: undefined,
      activeForm: undefined,
    });
    expect(parseTaskCreateArgs("not an object")).toEqual({
      subject: undefined,
      description: undefined,
      activeForm: undefined,
    });
    expect(parseTaskCreateArgs(null)).toEqual({
      subject: undefined,
      description: undefined,
      activeForm: undefined,
    });
  });
});

// A real `TaskUpdate` call is a partial patch, not a full list — every call
// in the captured fixture only ever carries `{taskId, status}`.
describe("parseTaskUpdateArgs", () => {
  it("reads taskId/status from a real TaskUpdate call", () => {
    expect(parseTaskUpdateArgs({ taskId: "1", status: "in_progress" })).toEqual({
      taskId: "1",
      status: "in_progress",
      subject: undefined,
      description: undefined,
      activeForm: undefined,
    });
  });

  it("also reads the older task_id spelling", () => {
    expect(parseTaskUpdateArgs({ task_id: "3", status: "completed" })).toEqual({
      taskId: "3",
      status: "completed",
      subject: undefined,
      description: undefined,
      activeForm: undefined,
    });
  });

  it("prefers taskId over task_id when both are present", () => {
    expect(parseTaskUpdateArgs({ taskId: "1", task_id: "2", status: "completed" })).toMatchObject({
      taskId: "1",
    });
  });

  it("reads subject/description/activeForm updates alongside or instead of status", () => {
    expect(
      parseTaskUpdateArgs({
        taskId: "4",
        description: "Merged to main as f9c3ba9.",
      }),
    ).toEqual({
      taskId: "4",
      status: undefined,
      subject: undefined,
      description: "Merged to main as f9c3ba9.",
      activeForm: undefined,
    });
  });

  it("degrades gracefully on a non-object args value", () => {
    expect(parseTaskUpdateArgs(undefined)).toEqual({
      taskId: undefined,
      status: undefined,
      subject: undefined,
      description: undefined,
      activeForm: undefined,
    });
    expect(parseTaskUpdateArgs("not an object")).toEqual({
      taskId: undefined,
      status: undefined,
      subject: undefined,
      description: undefined,
      activeForm: undefined,
    });
  });
});
